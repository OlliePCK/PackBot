const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('repeat')
        .setDescription('Set the repeat mode of the currently playing music.')
        .addStringOption(opt =>
            opt
                .setName('mode')
                .setDescription('Repeat modes')
                .setRequired(true)
                .addChoices(
                    { name: 'Queue repeat', value: 'queue' },
                    { name: 'Song repeat', value: 'song' },
                    { name: 'Repeat off', value: 'off' }
                )
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

        try {
            // Map choice to mode number: 0 = off, 1 = song, 2 = queue
            const modeMap = { off: 0, song: 1, queue: 2 };
            const choice = interaction.options.getString('mode');
            subscription.repeatMode = modeMap[choice];

            // Human-friendly text
            const modeText = subscription.repeatMode === 0
                ? 'Off'
                : subscription.repeatMode === 1
                    ? 'Repeat song'
                    : 'Repeat queue';

            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.repeat} Repeat mode set to **${modeText}**`)
                .setColor('#00ff00')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

            return interaction.editReply({ embeds: [embed] });
        } catch (e) {
            logger.error('Repeat command error: ' + (e.stack || e));
            const errEmbed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Couldn't set repeat mode.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [errEmbed] });
        }
    },
};
