const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('undo')
		.setDescription('Removes the last song from the queue.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		if (queue.songs.length <= 1) return interaction.editReply(`${interaction.client.emotes.error} | You can't undo the currently playing song!`);
		try {
			const spliced = queue.songs.splice(-1);
			const embed = new MessageEmbed()
				.setTitle(`${interaction.client.emotes.success} | Removed ${spliced[0].name}!`)
				.setDescription('Thank you for using The Pack music bot.')
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
				.setDescription('There is no song up next.')
				.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });
		}
	},
};