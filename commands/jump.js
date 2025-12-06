const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('jump')
        .setDescription('Jump to a song position in the queue.')
        .addIntegerOption(opt =>
            opt
                .setName('position')
                .setDescription('1 = first in queue, 2 = second... -1 = last, -2 = second-last, etc.')
                .setRequired(true)
        ),

    async execute(interaction, guildProfile) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (!subscription) {
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
            });
        }

        const pos = interaction.options.getInteger('position');
        const len = subscription.queue.length;
        
        if (len === 0) {
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | The queue is empty!`
            });
        }
        
        // Convert position to 0-based index
        const index = pos > 0
            ? pos - 1
            : len + pos;

        if (index < 0 || index >= len) {
            const errEmbed = new EmbedBuilder()
                .setTitle(`${interaction.client.emotes.error} | Invalid position`)
                .setDescription(`Please specify a number between 1 and ${len}, or -1 and -${len}.`)
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                .setColor('#ff006a');
            return interaction.editReply({ embeds: [errEmbed] });
        }

        try {
            await subscription.jump(index);
            
            // Delete the slash command reply since playSong event will show an embed
            await interaction.deleteReply().catch(() => {});
        } catch (e) {
            logger.error('Jump error: ' + (e.stack || e));
            const errEmbed = new EmbedBuilder()
                .setTitle(`${interaction.client.emotes.error} | Couldn't jump`)
                .setDescription('Something went wrongplease try a different position.')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                .setColor('#ff006a');
            return interaction.editReply({ embeds: [errEmbed] });
        }
    },
};
