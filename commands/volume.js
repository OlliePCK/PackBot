const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('volume')
		.setDescription('Set the volume level of the audio player (0–100).')
		.addIntegerOption(opt =>
			opt
				.setName('volume')
				.setDescription('Volume level from 0 to 100')
				.setRequired(true)
		),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
			});
		}

		const vol = interaction.options.getInteger('volume');
		if (vol < 0 || vol > 100) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | Please enter a number between 0 and 100.`
			});
		}

		try {
			queue.setVolume(vol);
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Volume set to \`${vol}%\``)
				.addFields(
					{ name: 'Requested by', value: `${interaction.user}`, inline: true },
					{ name: 'Volume', value: `\`${vol}%\``, inline: true }
				)
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		} catch (e) {
			console.error('Volume command error:', e);
			const errEmbed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | Couldn’t set volume`)
				.setDescription('Something went wrong—please try again.')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [errEmbed] });
		}
	},
};
