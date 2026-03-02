const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');
const QueryResolver = require('../music/QueryResolver');

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

    const getPlaybackSeconds = () => {
        const playbackMs = subscription.audioPlayer?.state?.resource?.playbackDuration;
        if (typeof playbackMs === 'number') {
            return Math.floor((playbackMs / 1000) + (subscription._currentTrackStartOffset || 0));
        }
        if (subscription.playbackStartTime) {
            return Math.floor((Date.now() - subscription.playbackStartTime) / 1000);
        }
        return 0;
    };

    // Fast path: use cached direct URL with FFmpeg input seeking (~200-500ms)
    let directUrl = track.directUrl || subscription.prefetchedUrls?.get(track.url);

    // If we don't have a direct URL yet for YouTube, wait for the in-flight background resolve (or start one).
    if (!directUrl && track.url && /youtube\.com|youtu\.be/i.test(track.url)) {
        const waitStart = Date.now();
        const existing = track._directUrlPromise;

        if (existing) {
            try {
                await existing;
            } catch {
                // ignore resolve errors; we'll fall back below
            }
        } else {
            const p = QueryResolver.getDirectStreamInfo(track.url)
                .then((streamInfo) => {
                    if (streamInfo?.directUrl) {
                        track.directUrl = streamInfo.directUrl;
                        track.directHeaders = streamInfo.directHeaders || null;
                        track._directUrlResolvedAt = Date.now();
                    }
                })
                .catch(() => {})
                .finally(() => {
                    if (track._directUrlPromise === p) {
                        delete track._directUrlPromise;
                    }
                });

            track._directUrlPromise = p;
            try {
                await p;
            } catch {
                // ignore
            }
        }

        directUrl = track.directUrl || subscription.prefetchedUrls?.get(track.url);
        const waitedMs = Date.now() - waitStart;
        if (waitedMs >= 250) {
            logger.info(`Waited ${waitedMs}ms for direct URL before filter restart`);
        }
    }

    const seekSeconds = Math.max(0, getPlaybackSeconds());
    if (directUrl) {
        const directHeaders = track.directHeaders || subscription.prefetchedHeaders?.get(track.url) || null;
        subscription._stopping = true;
        try {
            subscription._killPlaybackProcesses?.();
            const resource = await subscription.createAudioResourceWithFilters(directUrl, seekSeconds, subscription.filters, directHeaders);
            subscription.audioPlayer.play(resource);
            subscription.playbackStartTime = Date.now() - (seekSeconds * 1000);
            subscription._currentTrackStartOffset = seekSeconds;
            logger.info(`Filter restart via direct URL (seek=${seekSeconds}s, filters=${subscription.filters.length})`);
            return;
        } catch (err) {
            logger.warn(`Direct URL filter restart failed, falling back to yt-dlp: ${err.message}`);
            // Clear stale URL so we don't retry it
            track.directUrl = null;
            track.directHeaders = null;
        } finally {
            subscription._stopping = false;
        }
    }

    // Slow fallback: rebuild pipeline via yt-dlp piping (~3-7s)
    subscription._stopping = true;
    try {
        subscription._killPlaybackProcesses?.();
        track._seekOffset = Math.max(0, seekSeconds);

        const resource = await subscription.createAudioResource(track.url, null, null, subscription.filters);
        subscription.audioPlayer.play(resource);
        subscription.playbackStartTime = Date.now() - (seekSeconds * 1000);
        subscription._currentTrackStartOffset = seekSeconds;
        delete track._seekOffset;
        logger.info(`Filter restart via yt-dlp fallback (seek=${seekSeconds}s, filters=${subscription.filters.length})`);
    } finally {
        subscription._stopping = false;
    }
}
