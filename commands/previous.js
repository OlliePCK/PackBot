const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('previous')
        .setDescription('Plays the previous song.'),

    async execute(interaction, guildProfile) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (!subscription) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Not playing anything.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        if (subscription.history.length === 0) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | No previous track available.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        try {
            const previousTrack = await subscription.previous();
            
            // Delete the slash command reply since playSong event will show an embed
            await interaction.deleteReply().catch(() => {});
        } catch (e) {
            logger.error('Previous error: ' + (e.stack || e));
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Couldn't play previous track.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

            return interaction.editReply({ embeds: [embed] });
        }
    },
};
