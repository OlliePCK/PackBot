const { SlashCommandBuilder } = require('discord.js');

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
            return interaction.editReply('❌ Queue is empty!');
        }

        // Fisher-Yates shuffle
        for (let i = subscription.queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [subscription.queue[i], subscription.queue[j]] = [subscription.queue[j], subscription.queue[i]];
        }

        // Clear prefetched URLs since queue order changed, then prefetch the new next track
        subscription.prefetchedUrls.clear();
        if (subscription.queue.length > 0) {
            subscription.prefetchTrack(subscription.queue[0]);
        }

        interaction.editReply('🔀 Queue shuffled!');
    },
};
