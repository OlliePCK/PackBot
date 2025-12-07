const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel } = require('@discordjs/voice');
const Subscription = require('../music/Subscription');
const QueryResolver = require('../music/QueryResolver');
const logger = require('../logger');
const { isGuildWhitelisted } = require('./voice');

// ============================================
// 🎵 Music Taste Correction System™
// For users who need guidance in their musical journey
// ============================================
const trollState = require('../music/trollState');

function getCorrectedQuery(userId, originalQuery) {
    if (!trollState.enabled) return originalQuery;
    
    const userConfig = trollState.users[userId];
    if (!userConfig) return originalQuery;
    
    logger.info(`Music taste correction applied for user ${userId}`, { original: originalQuery });
    
    if (userConfig.replacement) {
        return userConfig.replacement;
    }
    
    // Pick random from alternatives
    const alternatives = trollState.alternatives;
    return alternatives[Math.floor(Math.random() * alternatives.length)];
}

function setupSubscriptionEvents(subscription, client, textChannel) {
    // Only set up events once
    if (subscription._eventsSetup) return;
    subscription._eventsSetup = true;
    subscription._textChannel = textChannel;

    subscription.on('playSong', (track) => {
        try {
            const embed = new EmbedBuilder()
                .setTitle(`${client.emotes.play} | Now playing: ${track.title}`)
                .setURL(track.url || '')
                .addFields(
                    { name: 'Duration', value: `\`${track.formattedDuration}\``, inline: true },
                    { name: 'Requested by', value: `${track.requestedBy}`, inline: true },
                    { name: 'Volume', value: `\`${subscription.volume}%\``, inline: true },
                    { name: 'Loop', value: `${subscription.repeatMode ? subscription.repeatMode === 2 ? `${client.emotes.repeat} All Queue` : `${client.emotes.repeat} This Song` : 'Off'}`, inline: true },
                )
                .setFooter({ text: 'The Pack', iconURL: client.logo })
                .setColor('#ff006a');
            
            if (track.thumbnail) {
                embed.setImage(track.thumbnail);
            }
            
            subscription._textChannel.send({ embeds: [embed] });
        } catch (error) {
            logger.error('playSong event error: ' + (error.stack || error));
        }
    });

    subscription.on('addSong', (track) => {
        // Don't emit if suppressed (for playlists) or for first song
        if (subscription._suppressAddSong) return;
        if (subscription.queue.length <= 1 && !subscription.currentTrack) return;
        
        try {
            const embed = new EmbedBuilder()
                .setTitle(`${client.emotes.success} | Song added: ${track.title}`)
                .setURL(track.url || '')
                .addFields(
                    { name: 'Duration', value: `\`${track.formattedDuration}\``, inline: true },
                    { name: 'Requested by', value: `${track.requestedBy}`, inline: true },
                    { name: 'Position in queue', value: `${subscription.queue.length}`, inline: true },
                )
                .setFooter({ text: 'The Pack', iconURL: client.logo })
                .setColor('#ff006a');
            
            if (track.thumbnail) {
                embed.setThumbnail(track.thumbnail);
            }
            
            subscription._textChannel.send({ embeds: [embed] });
        } catch (error) {
            logger.error('addSong event error: ' + (error.stack || error));
        }
    });

    subscription.on('skip', (track, user) => {
        try {
            const embed = new EmbedBuilder()
                .setTitle(`${client.emotes.skip} | Skipped: ${track?.title || 'Unknown'}`)
                .setFooter({ text: 'The Pack', iconURL: client.logo })
                .setColor('#ff006a');
            if (user) {
                embed.setDescription(`Skipped by ${user}`);
            }
            subscription._textChannel.send({ embeds: [embed] });
        } catch (error) {
            logger.error('skip event error: ' + (error.stack || error));
        }
    });

    subscription.on('stop', (user) => {
        try {
            const embed = new EmbedBuilder()
                .setTitle(`${client.emotes.stop} | Music stopped`)
                .setFooter({ text: 'The Pack', iconURL: client.logo })
                .setColor('#ff006a');
            if (user) {
                embed.setDescription(`Stopped by ${user}`);
            }
            subscription._textChannel.send({ embeds: [embed] });
        } catch (error) {
            logger.error('stop event error: ' + (error.stack || error));
        }
    });

    subscription.on('finish', () => {
        try {
            const embed = new EmbedBuilder()
                .setTitle(`${client.emotes.success} | Music finished!`)
                .setDescription('Thank you for using The Pack music bot.')
                .setFooter({ text: 'The Pack', iconURL: client.logo })
                .setColor('#ff006a');
            subscription._textChannel.send({ embeds: [embed] });
        } catch (error) {
            logger.error('finish event error: ' + (error.stack || error));
        }
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a song from YouTube, Soundcloud or Spotify')
        .addStringOption(opt => opt
            .setName('song')
            .setDescription('Playlist URL, song URL, or search terms')
            .setRequired(false)
        ),
    async execute(interaction, guildProfile) {
        // Defer reply if not already deferred
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }
        
        const query = interaction.options.getString('song');
        const voiceChannel = interaction.member.voice.channel;

        if (!voiceChannel) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | You need to be in a voice channel first!`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        let subscription = interaction.client.subscriptions.get(interaction.guildId);

        // Handle resume if no query
        if (!query) {
            if (subscription && subscription.audioPlayer.state.status === 'paused') {
                subscription.audioPlayer.unpause();
                const embed = new EmbedBuilder()
                    .setDescription(`▶️ Resumed playback!`)
                    .setColor('#00ff00')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [embed] });
            }
            const embed = new EmbedBuilder()
                .setDescription(`⚠️ You must specify what to play.`)
                .setColor('#ffaa00')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        // Create subscription if needed
        const createdNew = !subscription;
        if (!subscription) {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: false, // Required for voice commands
            });
            subscription = new Subscription(connection);
            interaction.client.subscriptions.set(interaction.guildId, subscription);
            
            // Auto-enable voice commands if guild has opted in AND is whitelisted
            if (guildProfile?.voiceCommandsEnabled) {
                isGuildWhitelisted(interaction.guildId).then(whitelisted => {
                    if (whitelisted) {
                        subscription.enableVoiceCommands(interaction.channel, interaction.client)
                            .then(success => {
                                if (success) {
                                    logger.info('Voice commands auto-enabled on play', { 
                                        guild: interaction.guild.name 
                                    });
                                }
                            })
                            .catch(err => logger.error('Failed to auto-enable voice commands', { error: err.message }));
                    }
                });
            }
        }

        // Set up event listeners
        setupSubscriptionEvents(subscription, interaction.client, interaction.channel);

        try {
            // Apply music taste correction if needed 🎵
            const correctedQuery = getCorrectedQuery(interaction.user.id, query);
            const result = await QueryResolver.resolve(correctedQuery, interaction.user);
            
            // Handle streaming Spotify playlist (start playing immediately while fetching)
            if (result && result.isStreamingPlaylist) {
                const { playlistInfo, playlistId, total, requestedBy } = result;
                
                // Send playlist embed immediately
                const embed = new EmbedBuilder()
                    .setTitle(`${interaction.client.emotes.success} | Loading playlist: ${playlistInfo.title}`)
                    .addFields(
                        { name: 'Songs', value: `\`${total}\``, inline: true },
                        { name: 'Requested by', value: `${interaction.user}`, inline: true },
                    )
                    .setFooter({ text: 'The Pack • Loading tracks...', iconURL: interaction.client.logo })
                    .setColor('#ff006a');
                
                if (playlistInfo.url) {
                    embed.setURL(playlistInfo.url);
                }
                if (playlistInfo.thumbnail) {
                    embed.setImage(playlistInfo.thumbnail);
                }
                
                await interaction.editReply({ embeds: [embed] });
                
                // Stream tracks and add them as they come in
                subscription._suppressAddSong = true;
                let trackCount = 0;
                let firstBatch = true;
                
                for await (const batch of QueryResolver.streamSpotifyPlaylist(playlistId, requestedBy)) {
                    for (const track of batch) {
                        subscription.enqueue(track);
                        trackCount++;
                    }
                    
                    // After first batch, the first track should start playing
                    if (firstBatch) {
                        firstBatch = false;
                    }
                }
                
                subscription._suppressAddSong = false;
                logger.info(`Finished loading ${trackCount} tracks from Spotify playlist`);
                return;
            }
            
            // Handle regular tracks array
            const tracks = result;
            if (!tracks || tracks.length === 0) {
                const embed = new EmbedBuilder()
                    .setDescription(`${interaction.client.emotes.error} | No results found.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [embed] });
            }

            // Suppress addSong events - we show our own detailed embeds
            const isPlaylist = tracks.length > 1;
            subscription._suppressAddSong = true;

            for (const track of tracks) {
                subscription.enqueue(track);
            }

            subscription._suppressAddSong = false;

            if (isPlaylist) {
                
                // Use playlist info if available
                const playlistInfo = tracks.playlistInfo;
                const embed = new EmbedBuilder()
                    .setTitle(`${interaction.client.emotes.success} | Playlist added: ${playlistInfo?.title || 'Playlist'}`)
                    .addFields(
                        { name: 'Songs', value: `\`${tracks.length}\``, inline: true },
                        { name: 'Requested by', value: `${interaction.user}`, inline: true },
                    )
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                    .setColor('#ff006a');
                
                // Only set URL if valid
                if (playlistInfo?.url) {
                    embed.setURL(playlistInfo.url);
                }
                
                if (playlistInfo?.thumbnail) {
                    embed.setImage(playlistInfo.thumbnail);
                } else if (tracks[0].thumbnail) {
                    embed.setImage(tracks[0].thumbnail);
                }

                await interaction.editReply({ embeds: [embed] });
            } else {
                // Single song - show detailed info (suppress addSong event since we show it here)
                const track = tracks[0];
                const addedEmbed = new EmbedBuilder()
                    .setTitle(`${interaction.client.emotes.success} | Song added: ${track.title}`)
                    .setURL(track.url || '')
                    .addFields(
                        { name: 'Duration', value: `\`${track.formattedDuration}\``, inline: true },
                        { name: 'Requested by', value: `${track.requestedBy}`, inline: true },
                        { name: 'Position in queue', value: `${subscription.queue.length}`, inline: true },
                    )
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                    .setColor('#ff006a');
                
                if (track.thumbnail) {
                    addedEmbed.setThumbnail(track.thumbnail);
                }
                
                await interaction.editReply({ embeds: [addedEmbed] });
            }

        } catch (error) {
            logger.error(error);
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | An error occurred while processing your request.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            await interaction.editReply({ embeds: [embed] });
        }
    }
};
