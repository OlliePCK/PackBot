const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('seek')
		.setDescription('Skip to a certain point in the song.')
		.addIntegerOption(option =>
			option.setName('time')
				.setDescription('Number of seconds to seek')
				.setRequired(true)),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		const time = interaction.options.getInteger('time');
		if (isNaN(time)) return interaction.editReply(`${interaction.client.emotes.error} | Please enter a valid number!`);
		try {
			queue.seek(time);
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Seeked to ${time} seconds!`)
				.addFields(
					{ name: 'Requested by', value: `${interaction.user}`, inline: true },
					{ name: 'Elapsed', value: `\`${queue.formattedCurrentTime}\u00A0\``, inline: true }
				)
				.setFooter({
					text: 'The Pack',
					iconURL: interaction.client.logo
				})
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });
		}
		catch (e) {
			console.log(e);
			return interaction.editReply(`${interaction.client.emotes.error} | An error occured, please try again!`);
		}
	},
};