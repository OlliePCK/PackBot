const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const Subscription = require('../music/Subscription');
const QueryResolver = require('../music/QueryResolver');
const logger = require('../logger');
const { isGuildWhitelisted } = require('./voice');
const db = require('../database/db');

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

function getVoiceJoinBlockReason(interaction, voiceChannel) {
    const me = interaction.guild.members.me;
    if (!me) {
        return 'I could not resolve my guild member record. Please try again.';
    }

    if (me.communicationDisabledUntilTimestamp && me.communicationDisabledUntilTimestamp > Date.now()) {
        return 'I am currently timed out in this server and cannot join voice channels.';
    }

    const perms = voiceChannel.permissionsFor(me);
    if (!perms) {
        return `I cannot view or access **${voiceChannel.name}**.`;
    }

    const missing = [];
    if (!perms.has(PermissionsBitField.Flags.ViewChannel)) missing.push('View Channel');
    if (!perms.has(PermissionsBitField.Flags.Connect)) missing.push('Connect');
    if (!perms.has(PermissionsBitField.Flags.Speak)) missing.push('Speak');
    if (missing.length > 0) {
        return `Missing permission(s) in **${voiceChannel.name}**: ${missing.join(', ')}.`;
    }

    const userLimit = voiceChannel.userLimit || 0;
    const alreadyInChannel = interaction.client.subscriptions.get(interaction.guildId)?.voiceConnection?.joinConfig?.channelId === voiceChannel.id;
    if (userLimit > 0 && !alreadyInChannel && voiceChannel.members.size >= userLimit) {
        return `**${voiceChannel.name}** is full (${voiceChannel.members.size}/${userLimit}).`;
    }

    return null;
}

function setupSubscriptionEvents(subscription, client, textChannel) {
    // Always update the text channel to the most recent one where commands are used
    subscription._textChannel = textChannel;
    
    // Only set up events once
    if (subscription._eventsSetup) return;
    subscription._eventsSetup = true;

    subscription.on('playSong', async (track) => {
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
            
            // Log to listening history
            try {
                // requestedBy can be a User object, a string mention, or a string like "username"
                let userId = null;
                let username = 'Unknown';
                
                if (track.requestedBy) {
                    if (typeof track.requestedBy === 'object' && track.requestedBy.id) {
                        // It's a User object
                        userId = track.requestedBy.id;
                        username = track.requestedBy.username || track.requestedBy.displayName || 'Unknown';
                    } else if (typeof track.requestedBy === 'string') {
                        // Try to extract from mention format <@123456789>
                        const userIdMatch = track.requestedBy.match(/<@!?(\d+)>/);
                        if (userIdMatch) {
                            userId = userIdMatch[1];
                            const guild = client.guilds.cache.get(subscription.guildId);
                            const member = guild?.members.cache.get(userId);
                            username = member?.displayName || member?.user?.username || 'Unknown';
                        }
                    }
                }
                
                if (userId) {
                    if (subscription.guildId) {
                        await db.pool.query(
                            `INSERT INTO ListeningHistory (guildId, odUserId, odUsername, trackTitle, trackArtist, trackUrl, trackThumbnail, durationSeconds)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                            [
                                subscription.guildId,
                                userId,
                                username,
                                track.title?.substring(0, 255) || 'Unknown',
                                track.artist?.substring(0, 255) || null,
                                track.url || null,
                                track.thumbnail || null,
                                Math.floor(track.duration || 0)
                            ]
                        );
                        logger.debug('Logged listening history', { userId, username, track: track.title });
                    } else {
                        logger.warn('Skipping listening history log: guildId is missing from subscription', { track: track.title });
                    }
                } else {
                    logger.warn('Could not extract userId from requestedBy', { requestedBy: track.requestedBy, type: typeof track.requestedBy });
                }
            } catch (dbError) {
                logger.error('Failed to log listening history: ' + (dbError.stack || dbError));
            }
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

async function waitForVoiceReadyWithRetry(connection, guildId, maxAttempts = 3, timeoutMs = 20_000) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
            return;
        } catch (error) {
            lastError = error;
            const state = connection?.state?.status || 'unknown';
            logger.warn('Voice ready wait failed on /play', {
                guild: guildId,
                attempt,
                maxAttempts,
                state,
                rejoinAttempts: connection?.rejoinAttempts || 0,
                error: error.message
            });

            if (attempt >= maxAttempts || state === VoiceConnectionStatus.Destroyed) {
                break;
            }

            try {
                connection.rejoin();
            } catch (rejoinErr) {
                logger.warn('Voice rejoin failed during /play ready retry', {
                    guild: guildId,
                    attempt,
                    error: rejoinErr.message
                });
            }
        }
    }

    throw lastError || new Error('Voice connection did not become Ready');
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
        
        const timingStart = Date.now();
        const logTimings = process.env.LOG_MUSIC_TIMINGS === '1' || process.env.LOG_MUSIC_TIMINGS === 'true';
        const query = interaction.options.getString('song');
        const voiceChannel = interaction.member.voice.channel;

        if (!voiceChannel) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | You need to be in a voice channel first!`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        const joinBlockReason = getVoiceJoinBlockReason(interaction, voiceChannel);
        if (joinBlockReason) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | ${joinBlockReason}`)
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
            let connection;
            try {
                connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: interaction.guildId,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                    selfDeaf: true, // Default to deafened, will undeafen if voice commands enabled
                });

                connection.on('stateChange', (oldState, newState) => {
                    logger.info('Voice init state change on /play', {
                        guild: interaction.guildId,
                        old: oldState.status,
                        next: newState.status,
                        reason: newState.reason || null,
                        closeCode: newState.closeCode ?? null,
                        rejoinAttempts: connection.rejoinAttempts || 0
                    });
                });

                // Don't start playback until voice is actually ready.
                await waitForVoiceReadyWithRetry(connection, interaction.guildId, 3, 20_000);
            } catch (error) {
                try {
                    connection?.destroy();
                } catch {
                    // ignore cleanup errors
                }
                logger.error('Failed to establish voice connection on /play', {
                    guild: interaction.guildId,
                    error: error.message,
                    state: connection?.state?.status || null
                });
                const embed = new EmbedBuilder()
                    .setDescription(`${interaction.client.emotes.error} | Failed to connect to voice. Check bot voice permissions, channel capacity, and ensure the bot image is updated for Discord's current voice encryption requirements.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [embed] });
            }

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
            const resolveStart = Date.now();
            const result = await QueryResolver.resolve(correctedQuery, interaction.user);
            const resolveMs = Date.now() - resolveStart;
            if (logTimings) {
                logger.info(`Timing: QueryResolver.resolve() took ${resolveMs}ms (slash:/play)`);
            }
            
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
                
                try {
                    for await (const batch of QueryResolver.streamSpotifyPlaylist(playlistId, requestedBy)) {
                        for (const track of batch) {
                            track._timing = track._timing || {};
                            track._timing.requestStart = timingStart;
                            track._timing.requestSource = 'slash:/play';
                            track._timing.resolveMs = resolveMs;
                            subscription.enqueue(track);
                            trackCount++;
                        }
                        
                        // After first batch, the first track should start playing
                        if (firstBatch) {
                            firstBatch = false;
                        }
                    }
                } finally {
                    subscription._suppressAddSong = false;
                }
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

            try {
                for (const track of tracks) {
                    track._timing = track._timing || {};
                    track._timing.requestStart = timingStart;
                    track._timing.requestSource = 'slash:/play';
                    track._timing.resolveMs = resolveMs;
                    subscription.enqueue(track);
                }
            } finally {
                subscription._suppressAddSong = false;
            }

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
