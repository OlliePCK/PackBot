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
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | There is nothing playing right now!`
            });
        }

        const time = interaction.options.getInteger('time');
        const currentTrack = subscription.currentTrack;
        
        // Validate within song duration
        if (time < 0 || (currentTrack.duration && time > currentTrack.duration)) {
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | Please enter a time between 0 and ${currentTrack.duration || '?'} seconds.`
            });
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
                .setTitle(`${interaction.client.emotes.success} | Seeked to ${formatTime(time)}!`)
                .addFields(
                    { name: 'Song', value: currentTrack.title, inline: true },
                    { name: 'Position', value: `\`${formatTime(time)}\``, inline: true },
                )
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                .setColor('#ff006a');

            return interaction.editReply({ embeds: [embed] });
        } catch (e) {
            logger.error('Seek error: ' + (e.stack || e));
            return interaction.editReply({
                content: `${interaction.client.emotes.error} | An error occurred while seeking—please try again!`
            });
        }
    },
};
