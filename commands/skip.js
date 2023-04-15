/* eslint-disable comma-dangle */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('skip')
		.setDescription('Skips the currently playing music.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		try {
			queue.skip()
				.then(() => {
					const embed = new EmbedBuilder()
						.setTitle(`${interaction.client.emotes.success} | Song has been skipped!`)
						.addFields(
							{ name: 'Requested by', value: `${interaction.user}`, inline: true },
						)
						.setFooter({
							text: 'The Pack',
							iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
						})
						.setColor('#ff006a');
					return interaction.editReply({ embeds: [embed] });
				})
				.catch(e => {
					queue.stop();
					const embed = new EmbedBuilder()
						.setTitle(`${interaction.client.emotes.success} | Song has been skipped!`)
						.addFields(
							{ name: 'Requested by', value: `${interaction.user}`, inline: true },
						)
						.setFooter({
							text: 'The Pack',
							iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
						})
						.setColor('#ff006a');
					return interaction.editReply({ embeds: [embed] });
				});
		}
		catch (e) {
			console.log(e);
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | An error occured!`)
				.setDescription('There is no song up next.')
				.setFooter({
					text: 'The Pack',
					iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
				})
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });
		}
	},
};