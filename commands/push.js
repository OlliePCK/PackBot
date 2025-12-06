const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('push')
        .setDescription('Move a song to play next (position 1 in queue).')
        .addIntegerOption(option =>
            option
                .setName('position')
                .setDescription('The position of the song to move (1 = first in queue)')
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
        
        if (pos < 1 || pos > len) {
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | Please enter a valid position between 1 and ${len}!`
            });
        }

        if (pos === 1) {
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | That song is already next!`
            });
        }

        try {
            // Remove song from its position and insert at front
            const idx = pos - 1;
            const [movedSong] = subscription.queue.splice(idx, 1);
            subscription.queue.unshift(movedSong);

            // Prefetch the newly moved track since it's now next
            subscription.prefetchTrack(movedSong);

            const embed = new EmbedBuilder()
                .setTitle(`${interaction.client.emotes.success} | Moved to next`)
                .setDescription(` **${movedSong.title || 'Unknown track'}** will play next.`)
                .addFields({ name: 'Requested by', value: `${interaction.user}`, inline: true })
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                .setColor('#ff006a');

            return interaction.editReply({ embeds: [embed] });
        } catch (e) {
            logger.error('Push command error: ' + (e.stack || e));
            const errEmbed = new EmbedBuilder()
                .setTitle(`${interaction.client.emotes.error} | Couldn't move that song`)
                .setDescription('Something went wrongplease try again.')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                .setColor('#ff006a');
            return interaction.editReply({ embeds: [errEmbed] });
        }
    },
};
