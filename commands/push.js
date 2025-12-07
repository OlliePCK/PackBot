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
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Not playing anything.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        const pos = interaction.options.getInteger('position');
        const len = subscription.queue.length;
        
        if (len === 0) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Queue is empty.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }
        
        if (pos < 1 || pos > len) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Please enter a valid position between 1 and ${len}.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        if (pos === 1) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | That song is already next.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        try {
            // Remove song from its position and insert at front
            const idx = pos - 1;
            const [movedSong] = subscription.queue.splice(idx, 1);
            subscription.queue.unshift(movedSong);

            // Prefetch the newly moved track since it's now next
            subscription.prefetchTrack(movedSong);

            const embed = new EmbedBuilder()
                .setDescription(`⏫ **${movedSong.title || 'Track'}** moved to play next.`)
                .setColor('#00ff00')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

            return interaction.editReply({ embeds: [embed] });
        } catch (e) {
            logger.error('Push command error: ' + (e.stack || e));
            const errEmbed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Couldn't move that song.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [errEmbed] });
        }
    },
};
