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
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Not playing anything.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        const pos1 = interaction.options.getInteger('position_1');
        const pos2 = interaction.options.getInteger('position_2');
        const len = subscription.queue.length;

        if (len < 2) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Need at least 2 songs in the queue to swap.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        // Validate positions (1-based)
        if (pos1 < 1 || pos1 > len || pos2 < 1 || pos2 > len) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Please enter valid positions between 1 and ${len}.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }
        if (pos1 === pos2) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Both positions are the same.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
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
            subscription.scheduleQueueUpdate();

            const embed = new EmbedBuilder()
                .setDescription(`🔀 Swapped positions **${pos1}** and **${pos2}**.`)
                .setColor('#00ff00')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

            return interaction.editReply({ embeds: [embed] });
        } catch (e) {
            logger.error('Swap command error: ' + (e.stack || e));
            const errEmbed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Couldn't swap songs.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [errEmbed] });
        }
    },
};
