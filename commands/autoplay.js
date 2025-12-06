const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('autoplay')
        .setDescription('Toggles the autoplay of music after the queue finishes.'),
    
    async execute(interaction, guildProfile) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (!subscription) {
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
            });
        }

        try {
            // Toggle autoplay
            subscription.autoplay = !subscription.autoplay;
            
            const embed = new EmbedBuilder()
                .setTitle(`${interaction.client.emotes.success} | Autoplay: \`${subscription.autoplay ? 'On' : 'Off'}\``)
                .setDescription(subscription.autoplay 
                    ? '🔄 When the queue ends, related songs will be automatically added.'
                    : '⏹️ Playback will stop when the queue ends.')
                .addFields(
                    { name: 'Requested by', value: `${interaction.user}`, inline: true }
                )
                .setFooter({
                    text: 'The Pack',
                    iconURL: interaction.client.logo
                })
                .setColor('#ff006a');
            
            return interaction.editReply({ embeds: [embed] });
        } catch (error) {
            logger.error(error.stack || error);
            const embed = new EmbedBuilder()
                .setTitle(`${interaction.client.emotes.error} | An error occurred!`)
                .setDescription('Please try again.')
                .setFooter({
                    text: 'The Pack',
                    iconURL: interaction.client.logo
                })
                .setColor('#ff006a');
            return interaction.editReply({ embeds: [embed] });
        }
    },
};