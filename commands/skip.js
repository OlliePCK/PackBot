/* eslint-disable comma-dangle */
const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('skip')
		.setDescription('Skips the currently playing music.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.reply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		try {
			queue.skip()
				.then(() => {
					const embed = new MessageEmbed()
						.setTitle(`${interaction.client.emotes.success} | Song has been skipped!`)
						.addFields(
							{ name: 'Requested by', value: `${interaction.user}`, inline: true },
						)
						.setFooter({
							text: 'The Pack',
							iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
						})
						.setColor('#ff006a');
					return interaction.reply({ embeds: [embed] });
				})
				.catch(e => {
					const embed = new MessageEmbed()
						.setTitle(`${interaction.client.emotes.error} | An error occured!`)
						.setDescription('There is no song up next.')
						.setFooter({
							text: 'The Pack',
							iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
						})
						.setColor('#ff006a');
					console.log(e);
					return interaction.reply({ embeds: [embed] });
				});
		}
		catch (e) {
			queue.stop();
			console.log(e);
			const embed = new MessageEmbed()
				.setTitle(`${interaction.client.emotes.error} | An error occured!`)
				.setDescription('There is no song up next. The music has been stopped.')
				.setFooter({
					text: 'The Pack',
					iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
				})
				.setColor('#ff006a');
			return interaction.reply({ embeds: [embed] });
		}
	},
};