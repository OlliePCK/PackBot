const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');

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
		if (!queue) return interaction.reply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		const time = Number(interaction.options.getInteger('time'));
		if (isNaN(time)) return interaction.reply(`${interaction.client.emotes.error} | Please enter a valid number!`);
		try {
			queue.seek(time);
			const embed = new MessageEmbed()
				.setTitle(`${interaction.client.emotes.success} | Seeked to ${time} seconds!`)
				.addFields(
					{ name: 'Requested by', value: `${interaction.user}`, inline: true },
				)
				.setFooter({
					text: 'The Pack',
					iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
				})
				.setColor('#ff006a');
			return interaction.reply({ embeds: [embed] });
		}
		catch (e) {
			console.log(e);
			return interaction.reply(`${interaction.client.emotes.error} | An error occured, please try again!`);
		}
	},
};