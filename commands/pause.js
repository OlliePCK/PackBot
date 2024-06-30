const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('pause')
		.setDescription('Pauses the currently playing music.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		if (queue.paused) {
			try {
				queue.resume();
			}
			catch (e) {
				console.log(e);
				const embed = new EmbedBuilder()
					.setTitle(`${interaction.client.emotes.error} | An error occured!`)
					.setDescription('Please try again.')
					.setFooter({
						text: 'The Pack',
						iconURL: 'https://i.imgur.com/L49zHx9.jpg'
					})
					.setColor('#ff006a');
				interaction.editReply({ embeds: [embed] });
			}
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | The song has been resumed!`)
				.addFields(
					{ name: 'Requested by', value: `${interaction.user}`, inline: true },
				)
				.setFooter({
					text: 'The Pack',
					iconURL: 'https://i.imgur.com/L49zHx9.jpg'
				})
				.setColor('#ff006a');
			interaction.editReply({ embeds: [embed] });
		}
		else {
			try {
				queue.pause();
				const embed = new EmbedBuilder()
					.setTitle(`${interaction.client.emotes.success} | The song has been paused!`)
					.addFields(
						{ name: 'Requested by', value: `${interaction.user}`, inline: true },
					)
					.setFooter({
						text: 'The Pack',
						iconURL: 'https://i.imgur.com/L49zHx9.jpg'
					})
					.setColor('#ff006a');
				interaction.editReply({ embeds: [embed] });
			}
			catch (e) {
				console.log(e);
				const embed = new EmbedBuilder()
					.setTitle(`${interaction.client.emotes.error} | An error occured!`)
					.setDescription('Please try again.')
					.setFooter({
						text: 'The Pack',
						iconURL: 'https://i.imgur.com/L49zHx9.jpg'
					})
					.setColor('#ff006a');
				interaction.editReply({ embeds: [embed] });
			}
		}
	},
};