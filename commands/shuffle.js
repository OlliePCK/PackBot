const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

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
					const embed = new EmbedBuilder()
						.setTitle(`${interaction.client.emotes.success} | The queue has been shuffled!`)
						.addFields(
							{ name: 'Requested by', value: `${interaction.user}`, inline: true },
						)
						.setFooter({
							text: 'The Pack',
							iconURL: interaction.client.logo
						})
						.setColor('#ff006a');
					return interaction.editReply({ embeds: [embed] });
				})
				.catch(() => {
					const embed = new EmbedBuilder()
						.setTitle(`${interaction.client.emotes.error} | An error occured!`)
						.setDescription('There was a problem shuffling the queue, try again shortly.')
						.setFooter({
							text: 'The Pack',
							iconURL: interaction.client.logo
						})
						.setColor('#ff006a');
					return interaction.editReply({ embeds: [embed] });
				});
		}
		catch (e) {
			console.log(e);
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | An error occured!`)
				.setDescription('There was a problem shuffling the queue, try again shortly.')
				.setFooter({
					text: 'The Pack',
					iconURL: interaction.client.logo
				})
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });
		}
	},
};