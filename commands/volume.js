const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('volume')
		.setDescription('Set the volume level of the audio player')
		.addIntegerOption(option =>
			option.setName('volume')
				.setDescription('Volume level out of 100')
				.setRequired(true)),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		const volume = parseInt(interaction.options.getInteger('volume'));
		if (isNaN(volume)) return interaction.editReply(`${interaction.client.emotes.error} | Please enter a valid number!`);
		try {
			queue.setVolume(volume);
			const embed = new MessageEmbed()
				.setTitle(`${interaction.client.emotes.success} | Changed the volume!`)
				.addFields(
					{ name: 'Requested by', value: `${interaction.user}`, inline: true },
					{ name: 'Volume', value: `${volume}%`, inline: true },
				)
				.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });

		}
		catch (e) {
			console.log(e);
			const embed = new MessageEmbed()
				.setTitle(`${interaction.client.emotes.error} | An error occured!`)
				.setDescription('There is no song up next.')
				.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });
		}
	},
};