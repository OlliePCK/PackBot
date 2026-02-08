const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');

function getMusicStreamMode() {
    const raw = (process.env.MUSIC_STREAM_MODE || '').trim().toLowerCase();
    if (raw === 'auto' || raw === 'direct' || raw === 'ytdlp') return raw;
    // Backwards compat with old flags.
    const disableDirect = process.env.DISABLE_DIRECT_URL === '1' || process.env.DISABLE_DIRECT_URL === 'true';
    if (disableDirect) return 'ytdlp';
    const preferStreaming = process.env.PREFER_YTDLP_STREAMING === '1' || process.env.PREFER_YTDLP_STREAMING === 'true';
    if (preferStreaming) return 'ytdlp';
    return 'auto';
}

function isYouTubeUrl(url) {
    return Boolean(url && /youtube\.com|youtu\.be/i.test(url));
}

function shouldUseYtdlpForUrl(url) {
    const mode = getMusicStreamMode();
    if (mode === 'ytdlp') return true;
    if (mode === 'direct') return false;
    return isYouTubeUrl(url);
}

// Available FFmpeg audio filters
const FILTERS = {
    'bassboost': { name: 'Bass Boost', value: 'bass=g=10' },
    'nightcore': { name: 'Nightcore', value: 'asetrate=48000*1.25,aresample=48000,atempo=1.06' },
    'vaporwave': { name: 'Vaporwave', value: 'asetrate=48000*0.8,aresample=48000,atempo=0.9' },
    '8d': { name: '8D Audio', value: 'apulsator=hz=0.08' },
    'tremolo': { name: 'Tremolo', value: 'tremolo' },
    'vibrato': { name: 'Vibrato', value: 'vibrato=f=6.5' },
    'reverse': { name: 'Reverse', value: 'areverse' },
    'treble': { name: 'Treble', value: 'treble=g=5' },
    'normalizer': { name: 'Normalizer', value: 'dynaudnorm=f=200' },
    'surrounding': { name: 'Surrounding', value: 'surround' },
    'earrape': { name: 'Earrape', value: 'channelsplit,sidechaingate=level_in=64' },
    'karaoke': { name: 'Karaoke', value: 'stereotools=mlev=0.03' },
    'flanger': { name: 'Flanger', value: 'flanger' },
    'gate': { name: 'Gate', value: 'agate' },
    'haas': { name: 'Haas', value: 'haas' },
    'mcompand': { name: 'Multi-band Compand', value: 'mcompand' },
    'phaser': { name: 'Phaser', value: 'aphaser=in_gain=0.4' },
    'pitch_up': { name: 'Pitch Up', value: 'asetrate=48000*1.15,aresample=48000' },
    'pitch_down': { name: 'Pitch Down', value: 'asetrate=48000*0.85,aresample=48000' },
    'slow': { name: 'Slow', value: 'atempo=0.8' },
    'fast': { name: 'Fast', value: 'atempo=1.25' }
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('filters')
        .setDescription('Apply audio filters to the music.')
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Add a filter to the current playback.')
                .addStringOption(opt =>
                    opt.setName('filter')
                        .setDescription('The filter to apply.')
                        .setRequired(true)
                        .addChoices(
                            ...Object.entries(FILTERS).map(([key, val]) => ({ name: val.name, value: key }))
                        )
                )
        )
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a filter from the current playback.')
                .addStringOption(opt =>
                    opt.setName('filter')
                        .setDescription('The filter to remove.')
                        .setRequired(true)
                        .addChoices(
                            ...Object.entries(FILTERS).map(([key, val]) => ({ name: val.name, value: key }))
                        )
                )
        )
        .addSubcommand(sub =>
            sub.setName('clear')
                .setDescription('Clear all active filters.')
        )
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Show all active filters.')
        ),

    async execute(interaction, guildProfile) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (!subscription) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Not playing anything.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        const subcommand = interaction.options.getSubcommand();

        // Initialize filters array if not present
        if (!subscription.filters) {
            subscription.filters = [];
        }

        try {
            if (subcommand === 'add') {
                const filterKey = interaction.options.getString('filter');
                const filter = FILTERS[filterKey];

                if (subscription.filters.includes(filterKey)) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${interaction.client.emotes.error} | The **${filter.name}** filter is already active!`)
                        .setColor('#ff0000')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }

                subscription.filters.push(filterKey);
                await restartWithFilters(subscription);

                const embed = new EmbedBuilder()
                    .setTitle(`${interaction.client.emotes.success} | Filter Added`)
                    .setDescription(`🎛️ **${filter.name}** has been applied.`)
                    .addFields(
                        { name: 'Active Filters', value: subscription.filters.map(f => FILTERS[f].name).join(', ') || 'None', inline: true },
                        { name: 'Requested by', value: `${interaction.user}`, inline: true }
                    )
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                    .setColor('#ff006a');

                return interaction.editReply({ embeds: [embed] });

            } else if (subcommand === 'remove') {
                const filterKey = interaction.options.getString('filter');
                const filter = FILTERS[filterKey];

                if (!subscription.filters.includes(filterKey)) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${interaction.client.emotes.error} | **${filter.name}** is not active.`)
                        .setColor('#ff0000')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }

                subscription.filters = subscription.filters.filter(f => f !== filterKey);
                await restartWithFilters(subscription);

                const embed = new EmbedBuilder()
                    .setDescription(`🎛️ **${filter.name}** filter removed.`)
                    .addFields(
                        { name: 'Active Filters', value: subscription.filters.map(f => FILTERS[f].name).join(', ') || 'None', inline: true }
                    )
                    .setColor('#00ff00')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

                return interaction.editReply({ embeds: [embed] });

            } else if (subcommand === 'clear') {
                if (subscription.filters.length === 0) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${interaction.client.emotes.error} | No active filters to clear.`)
                        .setColor('#ff0000')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }

                subscription.filters = [];
                await restartWithFilters(subscription);

                const embed = new EmbedBuilder()
                    .setDescription('🏛️ All filters cleared.')
                    .setColor('#00ff00')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

                return interaction.editReply({ embeds: [embed] });

            } else if (subcommand === 'list') {
                const activeFilters = subscription.filters.map(f => FILTERS[f]?.name || f);

                const embed = new EmbedBuilder()
                    .setTitle('🎛️ Audio Filters')
                    .addFields(
                        { name: 'Active Filters', value: activeFilters.length > 0 ? activeFilters.join(', ') : 'None' },
                        { name: 'Available Filters', value: Object.values(FILTERS).map(f => f.name).join(', ') }
                    )
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                    .setColor('#ff006a');

                return interaction.editReply({ embeds: [embed] });
            }
        } catch (error) {
            logger.error(`Filters command error: ${error.stack || error}`);
            const errEmbed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Couldn't apply filter. Please try again.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [errEmbed] });
        }
    },
};

// Helper to restart playback with new filters while preserving position
async function restartWithFilters(subscription) {
    if (!subscription.currentTrack) return;

    const track = subscription.currentTrack;

    // Calculate approximate current position in seconds
    let seekSeconds = 0;
    if (subscription.playbackStartTime) {
        seekSeconds = Math.floor((Date.now() - subscription.playbackStartTime) / 1000);
    }

    // In stable mode, avoid direct googlevideo streaming for YouTube. Rebuild the pipeline via yt-dlp piping.
    if (shouldUseYtdlpForUrl(track.url)) {
        subscription._stopping = true;
        try {
            subscription._killPlaybackProcesses?.();

            // Force yt-dlp path inside createAudioResource by omitting directUrl and setting a seek offset.
            track._seekOffset = Math.max(0, seekSeconds);
            track.directUrl = null;
            track.directHeaders = null;

            const resource = await subscription.createAudioResource(track.url, null, null, subscription.filters);
            subscription.audioPlayer.play(resource);
            subscription.playbackStartTime = Date.now() - (seekSeconds * 1000);
            subscription._currentTrackStartOffset = seekSeconds;
            delete track._seekOffset;
        } finally {
            subscription._stopping = false;
        }
        return;
    }

    // Always fetch a fresh direct URL - cached URLs may be expired
    const QueryResolver = require('../music/QueryResolver');
    let streamInfo = null;

    if (track.url) {
        try {
            streamInfo = await QueryResolver.getDirectStreamInfo(track.url);
        } catch (err) {
            logger.warn(`Failed to get fresh stream URL: ${err.message}`);
        }
    }

    // Fallback to cached URLs if fresh fetch fails
    if (!streamInfo?.directUrl) {
        streamInfo = {
            directUrl: track.directUrl || subscription.prefetchedUrls?.get(track.url),
            directHeaders: track.directHeaders || subscription.prefetchedHeaders?.get(track.url)
        };
    }

    if (!streamInfo?.directUrl) {
        throw new Error('Could not get stream URL for filter application');
    }

    // Re-create the audio resource with filters and seek position
    try {
        subscription._stopping = true;
        try {
            subscription._killPlaybackProcesses?.();
            const resource = await subscription.createAudioResourceWithFilters(streamInfo.directUrl, seekSeconds, subscription.filters, streamInfo.directHeaders);
            subscription.audioPlayer.play(resource);
            // Update start time accounting for the seek
            subscription.playbackStartTime = Date.now() - (seekSeconds * 1000);
            subscription._currentTrackStartOffset = seekSeconds;
        } finally {
            subscription._stopping = false;
        }
    } catch (error) {
        logger.error(`Failed to restart with filters: ${error}`);
        throw error;
    }
}
