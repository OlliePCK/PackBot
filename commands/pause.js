const { SlashCommandBuilder } = require('discord.js');
const { AudioPlayerStatus } = require('@discordjs/voice');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Pauses or resumes the currently playing music.'),
    async execute(interaction) {
        // Defer reply if not already deferred
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }

        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (!subscription) {
            return interaction.editReply('❌ Not playing!');
        }

        if (subscription.audioPlayer.state.status === AudioPlayerStatus.Paused) {
            subscription.audioPlayer.unpause();
            interaction.editReply('▶️ Resumed!');
        } else if (subscription.audioPlayer.state.status === AudioPlayerStatus.Playing) {
            subscription.audioPlayer.pause();
            interaction.editReply('⏸️ Paused!');
        } else {
            interaction.editReply('❌ Not playing!');
        }
    },
};
