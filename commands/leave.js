const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('leave')
		.setDescription('Disconnect the music bot from the voice channel.'),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | I’m not playing anything right now!`
			});
		}

		try {
			// Kick the bot out of voice
			interaction.client.distube.voices.leave(interaction);

			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Left the voice channel!`)
				.setDescription('Thank you for using The Pack music bot.')
				.addFields(
					{ name: 'Requested by', value: `${interaction.user}`, inline: true },
				)
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		} catch (e) {
			console.error('Leave error:', e);
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | An error occurred!`)
				.setDescription('Couldn’t leave the voice channel—please try again.')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		}
	},
};
