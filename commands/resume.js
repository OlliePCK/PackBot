const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('resume')
		.setDescription('Resume the currently paused song.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		if (queue.paused) {
			try {
				queue.resume();
			}
			catch (e) {
				console.log(e);
				const embed = new MessageEmbed()
					.setTitle(`${interaction.client.emotes.error} | An error occured!`)
					.setDescription('Please try again.')
					.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
					.setColor('#ff006a');
				return interaction.editReply({ embeds: [embed] });
			}
			const embed = new MessageEmbed()
				.setTitle(`${interaction.client.emotes.success} | The song has been resumed!`)
				.addFields(
					{ name: 'Requested by', value: `${interaction.user}`, inline: true },
				)
				.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });
		}
		else {
			try {
				queue.pause();
				const embed = new MessageEmbed()
					.setTitle(`${interaction.client.emotes.success} | The song has been paused!`)
					.addFields(
						{ name: 'Requested by', value: `${interaction.user}`, inline: true },
					)
					.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
					.setColor('#ff006a');
				return interaction.editReply({ embeds: [embed] });
			}
			catch (e) {
				console.log(e);
				const embed = new MessageEmbed()
					.setTitle(`${interaction.client.emotes.error} | An error occured!`)
					.setDescription('Please try again.')
					.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
					.setColor('#ff006a');
				return interaction.editReply({ embeds: [embed] });
			}
		}
	},
};