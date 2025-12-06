const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop the music and clear the queue'),
    async execute(interaction) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (subscription) {
            subscription.stop(interaction.user);
            // Delete the deferred reply - the event embed will be the response
            await interaction.deleteReply();
        } else {
            interaction.editReply('❌ Not playing!');
        }
    },
};
