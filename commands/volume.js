const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('volume')
        .setDescription('Set the volume level of the audio player (0–100).')
        .addIntegerOption(opt =>
            opt
                .setName('volume')
                .setDescription('Volume level from 0 to 100')
                .setRequired(true)
        ),

    async execute(interaction) {
        // Defer reply if not already deferred
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }

        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (!subscription) {
            return interaction.editReply('❌ Not playing!');
        }

        const vol = interaction.options.getInteger('volume');
        if (vol < 0 || vol > 100) {
            return interaction.editReply('❌ Please enter a number between 0 and 100.');
        }

        subscription.setVolume(vol);
        interaction.editReply(`🔊 Volume set to ${vol}%`);
    },
};
