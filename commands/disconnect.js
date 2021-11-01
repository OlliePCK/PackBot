const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('disconnect')
		.setDescription('Disconnect the music bot from the voice channel.'),
	async execute(interaction) {
		if (!interaction.client.distube.voices.get(interaction)) return interaction.editReply(`${interaction.client.emotes.error} | The bot is not in a voice channel!`);
		try {
			interaction.client.distube.voices.leave(interaction);
			const embed = new MessageEmbed()
				.setTitle(`${interaction.client.emotes.success} | Left the voice channel!`)
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
				.setDescription('Please try again or manually disconnect the bot!')
				.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });
		}
	},
};