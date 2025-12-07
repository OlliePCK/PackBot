const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('seek')
        .setDescription('Skip to a certain point in the song.')
        .addIntegerOption(opt =>
            opt
                .setName('time')
                .setDescription('Number of seconds to seek')
                .setRequired(true)
        ),

    async execute(interaction, guildProfile) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        
        if (!subscription || !subscription.currentTrack) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Not playing anything.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        const time = interaction.options.getInteger('time');
        const currentTrack = subscription.currentTrack;
        
        // Validate within song duration
        if (time < 0 || (currentTrack.duration && time > currentTrack.duration)) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Please enter a time between 0 and ${currentTrack.duration || '?'} seconds.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        try {
            // Seek by restarting the stream with a time offset
            await subscription.seek(time);

            const formatTime = (secs) => {
                const mins = Math.floor(secs / 60);
                const s = secs % 60;
                return `${mins}:${s.toString().padStart(2, '0')}`;
            };

            const embed = new EmbedBuilder()
                .setDescription(`⏩ Seeked to **${formatTime(time)}** in **${currentTrack.title}**`)
                .setColor('#00ff00')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

            return interaction.editReply({ embeds: [embed] });
        } catch (e) {
            logger.error('Seek error: ' + (e.stack || e));
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Couldn't seek to that position.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }
    },
};
