const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

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
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Not playing anything.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        const vol = interaction.options.getInteger('volume');
        if (vol < 0 || vol > 100) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Please enter a number between 0 and 100.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        subscription.setVolume(vol);
        const embed = new EmbedBuilder()
            .setDescription(`🔊 Volume set to **${vol}%**`)
            .setColor('#00ff00')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        return interaction.editReply({ embeds: [embed] });
    },
};
