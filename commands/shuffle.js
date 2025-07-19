const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('shuffle')
		.setDescription('Shuffles all songs in the queue.'),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
			});
		}

		try {
			await queue.shuffle();

			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Queue shuffled!`)
				.addFields({ name: 'Requested by', value: `${interaction.user}`, inline: true })
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		} catch (e) {
			console.error('Shuffle error:', e);

			const errEmbed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | Couldn’t shuffle`)
				.setDescription('There was a problem shuffling the queue—please try again shortly.')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [errEmbed] });
		}
	},
};
