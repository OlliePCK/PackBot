const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('autoplay')
		.setDescription('Toggles the autoplay of music after the queue finishes.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		try {
			const autoplay = queue.toggleAutoplay();
			const embed = new MessageEmbed()
				.setTitle(`${interaction.client.emotes.success} | Autoplay: \`${autoplay ? 'On' : 'Off'}\``)
				.addFields(
					{ name: 'Requested by', value: `${interaction.user}`, inline: true },
				)
				.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
				.setColor('#ff006a');
			interaction.editReply({ embeds: [embed] });
		}
		catch (e) {
			console.log(e);
			const embed = new MessageEmbed()
				.setTitle(`${interaction.client.emotes.error} | An error occured!`)
				.setDescription('Please try again.')
				.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
				.setColor('#ff006a');
			interaction.editReply({ embeds: [embed] });
		}
	},
};