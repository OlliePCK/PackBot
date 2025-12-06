const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('undo')
        .setDescription('Removes the last song from the queue.'),

    async execute(interaction, guildProfile) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (!subscription) {
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
            });
        }

        if (subscription.queue.length === 0) {
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | The queue is emptynothing to remove!`
            });
        }

        try {
            // Remove the last song in the queue
            const removed = subscription.queue.pop();

            const embed = new EmbedBuilder()
                .setTitle(`${interaction.client.emotes.success} | Removed from queue`)
                .setDescription(`**${removed.title || 'Unknown track'}** has been removed.`)
                .addFields({ name: 'Requested by', value: `${interaction.user}`, inline: true })
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                .setColor('#ff006a');

            return interaction.editReply({ embeds: [embed] });
        } catch (e) {
            logger.error('Undo command error: ' + (e.stack || e));
            const errEmbed = new EmbedBuilder()
                .setTitle(`${interaction.client.emotes.error} | Couldn't remove last song`)
                .setDescription('Something went wrongplease try again.')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                .setColor('#ff006a');
            return interaction.editReply({ embeds: [errEmbed] });
        }
    },
};
