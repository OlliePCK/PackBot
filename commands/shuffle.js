const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('shuffle')
        .setDescription('Shuffles all songs in the queue.'),
    async execute(interaction) {
        // Defer reply if not already deferred
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }

        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (!subscription || subscription.queue.length === 0) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Queue is empty.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        // Fisher-Yates shuffle
        for (let i = subscription.queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [subscription.queue[i], subscription.queue[j]] = [subscription.queue[j], subscription.queue[i]];
        }

        // Clear prefetched URLs since queue order changed, then prefetch the new next track
        subscription.prefetchedUrls.clear();
        subscription.prefetchedHeaders?.clear();
        subscription._clearPrefetchedStreams?.();
        if (subscription.queue.length > 0) {
            subscription.prefetchTrack(subscription.queue[0]);
        }
        subscription.scheduleQueueUpdate();

        const embed = new EmbedBuilder()
            .setDescription(`🔀 Shuffled **${subscription.queue.length}** songs in the queue.`)
            .setColor('#00ff00')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        return interaction.editReply({ embeds: [embed] });
    },
};
