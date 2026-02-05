const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Leave the voice channel'),
    async execute(interaction) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (!subscription) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Not in a voice channel.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return await interaction.editReply({ embeds: [embed] });
        }

        // Clear queue without emitting stop event
        subscription.queueLock = true;
        subscription.queue = [];
        subscription.currentTrack = null;
        subscription.prefetchedUrls.clear();
        subscription.prefetchedHeaders?.clear();
        subscription._clearPrefetchedStreams?.();
        subscription.audioPlayer.stop(true);
        subscription.queueLock = false;

        // Set flag so Subscription knows this is intentional
        subscription._manualDisconnect = true;
        subscription.voiceConnection.destroy();
        interaction.client.subscriptions.delete(interaction.guildId);

        const embed = new EmbedBuilder()
            .setDescription(`👋 Left the voice channel.`)
            .setColor('#00ff00')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        return await interaction.editReply({ embeds: [embed] });
    },
};
