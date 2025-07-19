const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('previous')
		.setDescription('Plays the previous song.'),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
			});
		}

		try {
			const song = await queue.previous();
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Playing previous:`)
				.setDescription(`▶️ Now playing **${song.name}**`)
				.addFields({ name: 'Requested by', value: `${interaction.user}`, inline: true })
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		} catch (e) {
			console.error('Previous error:', e);
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | Couldn’t play previous song`)
				.setDescription('There is no previous song available.')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		}
	},
};
