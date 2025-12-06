const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('previous')
        .setDescription('Plays the previous song.'),

    async execute(interaction, guildProfile) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (!subscription) {
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
            });
        }

        if (subscription.history.length === 0) {
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | There is no previous song available!`
            });
        }

        try {
            const previousTrack = await subscription.previous();
            
            // Delete the slash command reply since playSong event will show an embed
            await interaction.deleteReply().catch(() => {});
        } catch (e) {
            logger.error('Previous error: ' + (e.stack || e));
            const embed = new EmbedBuilder()
                .setTitle(`${interaction.client.emotes.error} | Couldn't play previous song`)
                .setDescription('There is no previous song available.')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                .setColor('#ff006a');

            return interaction.editReply({ embeds: [embed] });
        }
    },
};
