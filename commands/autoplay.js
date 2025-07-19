const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('autoplay')
		.setDescription('Toggles the autoplay of music after the queue finishes.'),
	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply({ content: `${interaction.client.emotes.error} | There is nothing in the queue right now!` });
		try {
			const autoplay = queue.toggleAutoplay();
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Autoplay: \`${autoplay ? 'On' : 'Off'}\``)
				.addFields(
					{ name: 'Requested by', value: `${interaction.user}`, inline: true },
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
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | An error occured!`)
				.setDescription('Please try again.')
				.setFooter({
					text: 'The Pack',
					iconURL: interaction.client.logo
				})
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });
		}
	},
};