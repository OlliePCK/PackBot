const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('swap')
        .setDescription('Swap the positions of two songs in the queue.')
        .addIntegerOption(opt =>
            opt
                .setName('position_1')
                .setDescription('The position of the first song to swap (1 = first in queue).')
                .setRequired(true)
        )
        .addIntegerOption(opt =>
            opt
                .setName('position_2')
                .setDescription('The position of the second song to swap.')
                .setRequired(true)
        ),

    async execute(interaction, guildProfile) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (!subscription) {
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
            });
        }

        const pos1 = interaction.options.getInteger('position_1');
        const pos2 = interaction.options.getInteger('position_2');
        const len = subscription.queue.length;

        if (len < 2) {
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | Need at least 2 songs in the queue to swap!`
            });
        }

        // Validate positions (1-based)
        if (pos1 < 1 || pos1 > len || pos2 < 1 || pos2 > len) {
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | Please enter valid positions between 1 and ${len}!`
            });
        }
        if (pos1 === pos2) {
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | Both positions are the samenothing to swap.`
            });
        }

        try {
            // Convert to 0-based indices
            const idx1 = pos1 - 1;
            const idx2 = pos2 - 1;
            
            // Swap in the queue
            [subscription.queue[idx1], subscription.queue[idx2]] = [subscription.queue[idx2], subscription.queue[idx1]];

            // Prefetch the new first track if position 1 was affected
            if ((idx1 === 0 || idx2 === 0) && subscription.queue.length > 0) {
                subscription.prefetchTrack(subscription.queue[0]);
            }

            const embed = new EmbedBuilder()
                .setTitle(`${interaction.client.emotes.success} | Swapped songs!`)
                .setDescription(`Positions **${pos1}** and **${pos2}** have been swapped.`)
                .addFields({ name: 'Requested by', value: `${interaction.user}`, inline: true })
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                .setColor('#ff006a');

            return interaction.editReply({ embeds: [embed] });
        } catch (e) {
            logger.error('Swap command error: ' + (e.stack || e));
            const errEmbed = new EmbedBuilder()
                .setTitle(`${interaction.client.emotes.error} | Couldn't swap songs`)
                .setDescription('Something went wrongplease try again.')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                .setColor('#ff006a');
            return interaction.editReply({ embeds: [errEmbed] });
        }
    },
};
