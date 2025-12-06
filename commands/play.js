const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel } = require('@discordjs/voice');
const Subscription = require('../music/Subscription');
const QueryResolver = require('../music/QueryResolver');
const logger = require('../logger');

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
    async execute(interaction) {
        // Defer reply if not already deferred
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }
        
        const query = interaction.options.getString('song');
        const voiceChannel = interaction.member.voice.channel;

        if (!voiceChannel) {
            return interaction.editReply('🚫 You need to be in a voice channel first!');
        }

        let subscription = interaction.client.subscriptions.get(interaction.guildId);

        // Handle resume if no query
        if (!query) {
            if (subscription && subscription.audioPlayer.state.status === 'paused') {
                subscription.audioPlayer.unpause();
                return interaction.editReply('▶️ Resumed playback!');
            }
            return interaction.editReply('⚠️ You must specify what to play.');
        }

        // Create subscription if needed
        if (!subscription) {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
            });
            subscription = new Subscription(connection);
            interaction.client.subscriptions.set(interaction.guildId, subscription);
        }

        // Set up event listeners
        setupSubscriptionEvents(subscription, interaction.client, interaction.channel);

        try {
            const result = await QueryResolver.resolve(query, interaction.user);
            
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
                return interaction.editReply('❌ No results found.');
            }

            // Suppress addSong events for playlist items
            const isPlaylist = tracks.length > 1;
            if (isPlaylist) {
                subscription._suppressAddSong = true;
            }

            for (const track of tracks) {
                subscription.enqueue(track);
            }

            if (isPlaylist) {
                subscription._suppressAddSong = false;
                
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
                await interaction.editReply('✅ Added to queue!');
            }

        } catch (error) {
            logger.error(error);
            await interaction.editReply('❌ An error occurred while processing your request.');
        }
    }
};
