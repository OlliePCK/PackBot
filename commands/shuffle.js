const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('shuffle')
		.setDescription('Shuffles all songs in the queue.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		try {
			queue.shuffle()
				.then(() => {
					const embed = new MessageEmbed()
						.setTitle(`${interaction.client.emotes.success} | The queue has been shuffled!`)
						.addFields(
							{ name: 'Requested by', value: `${interaction.user}`, inline: true },
						)
						.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
						.setColor('#ff006a');
					return interaction.editReply({ embeds: [embed] });
				})
				.catch(() => {
					const embed = new MessageEmbed()
						.setTitle(`${interaction.client.emotes.error} | An error occured!`)
						.setDescription('There was a problem shuffling the queue, try again shortly.')
						.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
						.setColor('#ff006a');
					return interaction.editReply({ embeds: [embed] });
				});
		}
		catch (e) {
			console.log(e);
			const embed = new MessageEmbed()
				.setTitle(`${interaction.client.emotes.error} | An error occured!`)
				.setDescription('There was a problem shuffling the queue, try again shortly.')
				.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });
		}
	},
};