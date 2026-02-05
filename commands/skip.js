const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skip the current song'),
    async execute(interaction) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (!subscription) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Not playing anything.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return await interaction.editReply({ embeds: [embed] });
        }

        try {
            subscription.skip(interaction.user);
            // Delete the deferred reply - the event embed will be the response
            await interaction.deleteReply().catch(() => {});
        } catch (e) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Couldn't skip the track.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return await interaction.editReply({ embeds: [embed] });
        }
    },
};
