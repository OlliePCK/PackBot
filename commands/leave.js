const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Leave the voice channel'),
    async execute(interaction) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (subscription) {
            // Clear queue without emitting stop event
            subscription.queueLock = true;
            subscription.queue = [];
            subscription.currentTrack = null;
            subscription.prefetchedUrls.clear();
            subscription.audioPlayer.stop(true);
            subscription.queueLock = false;
            
            subscription.voiceConnection.destroy();
            interaction.client.subscriptions.delete(interaction.guildId);
            
            const embed = new EmbedBuilder()
                .setDescription(`👋 Left the voice channel.`)
                .setColor('#ff006a')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            interaction.editReply({ embeds: [embed] });
        } else {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Not in a voice channel.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            interaction.editReply({ embeds: [embed] });
        }
    },
};
