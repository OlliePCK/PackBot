const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('undo')
        .setDescription('Removes the last song from the queue.'),

    async execute(interaction, guildProfile) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (!subscription) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | There is nothing in the queue right now!`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        if (subscription.queue.length === 0) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | The queue is empty—nothing to remove!`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        try {
            // Remove the last song in the queue
            const removed = subscription.queue.pop();
            subscription.scheduleQueueUpdate();

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
                .setDescription(`${interaction.client.emotes.error} | Couldn't remove last song. Please try again.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [errEmbed] });
        }
    },
};
