const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('previous')
		.setDescription('Plays the previous song.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.reply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		try {
			queue.previous()
				.then(() => {
					const embed = new EmbedBuilder()
						.setTitle(`${interaction.client.emotes.success} | Previous song added!`)
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
				.catch(() => {
					const embed = new EmbedBuilder()
						.setTitle(`${interaction.client.emotes.error} | An error occured!`)
						.setDescription('There is no previous song available.')
						.setFooter({
							text: 'The Pack',
							iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
						})
						.setColor('#ff006a');
					return interaction.reply({ embeds: [embed] });
				});
		}
		catch (e) {
			console.log(e);
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | An error occured!`)
				.setDescription('There is no previous song available.')
				.setFooter({
					text: 'The Pack',
					iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
				})
				.setColor('#ff006a');
			return interaction.reply({ embeds: [embed] });
		}
	},
};