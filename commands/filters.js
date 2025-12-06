const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');

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
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | There is nothing playing right now!`
            });
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
                    return interaction.editReply({
                        content: `${interaction.client.emotes.error} | The **${filter.name}** filter is already active!`
                    });
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
                    return interaction.editReply({
                        content: `${interaction.client.emotes.error} | The **${filter.name}** filter is not active!`
                    });
                }

                subscription.filters = subscription.filters.filter(f => f !== filterKey);
                await restartWithFilters(subscription);

                const embed = new EmbedBuilder()
                    .setTitle(`${interaction.client.emotes.success} | Filter Removed`)
                    .setDescription(`🎛️ **${filter.name}** has been removed.`)
                    .addFields(
                        { name: 'Active Filters', value: subscription.filters.map(f => FILTERS[f].name).join(', ') || 'None', inline: true },
                        { name: 'Requested by', value: `${interaction.user}`, inline: true }
                    )
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                    .setColor('#ff006a');

                return interaction.editReply({ embeds: [embed] });

            } else if (subcommand === 'clear') {
                if (subscription.filters.length === 0) {
                    return interaction.editReply({
                        content: `${interaction.client.emotes.error} | There are no active filters to clear!`
                    });
                }

                subscription.filters = [];
                await restartWithFilters(subscription);

                const embed = new EmbedBuilder()
                    .setTitle(`${interaction.client.emotes.success} | Filters Cleared`)
                    .setDescription('🎛️ All audio filters have been removed.')
                    .addFields({ name: 'Requested by', value: `${interaction.user}`, inline: true })
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                    .setColor('#ff006a');

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
                .setTitle(`${interaction.client.emotes.error} | Couldn't apply filter`)
                .setDescription('Something went wrong—please try again.')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                .setColor('#ff006a');
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
    
    // Get direct URL for the track
    const QueryResolver = require('../music/QueryResolver');
    let streamUrl = track.directUrl || subscription.prefetchedUrls.get(track.url);
    if (!streamUrl && track.url) {
        streamUrl = await QueryResolver.getDirectStreamUrl(track.url);
    }
    
    if (!streamUrl) {
        throw new Error('Could not get stream URL for filter application');
    }
    
    // Re-create the audio resource with filters and seek position
    try {
        const resource = await subscription.createAudioResourceWithFilters(streamUrl, seekSeconds, subscription.filters);
        subscription.audioPlayer.play(resource);
        // Update start time accounting for the seek
        subscription.playbackStartTime = Date.now() - (seekSeconds * 1000);
    } catch (error) {
        logger.error(`Failed to restart with filters: ${error}`);
        throw error;
    }
}
