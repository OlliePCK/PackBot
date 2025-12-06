const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skip the current song'),
    async execute(interaction) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (subscription) {
            subscription.skip(interaction.user);
            // Delete the deferred reply - the event embed will be the response
            await interaction.deleteReply();
        } else {
            interaction.editReply('❌ Not playing!');
        }
    },
};
