const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('pause')
		.setDescription('Pauses or resumes the currently playing music.'),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
			});
		}

		try {
			let embed;
			if (queue.paused) {
				await queue.resume();
				embed = new EmbedBuilder()
					.setTitle(`${interaction.client.emotes.success} | Resumed!`)
					.setDescription('▶️ Music playback has been resumed.')
					.addFields({ name: 'Requested by', value: `${interaction.user}`, inline: true });
			} else {
				await queue.pause();
				embed = new EmbedBuilder()
					.setTitle(`${interaction.client.emotes.success} | Paused!`)
					.setDescription('⏸️ Music playback has been paused.')
					.addFields({ name: 'Requested by', value: `${interaction.user}`, inline: true });
			}

			embed
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		} catch (e) {
			console.error('Pause/Resume error:', e);
			const errorEmbed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | An error occurred!`)
				.setDescription('Please try again.')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [errorEmbed] });
		}
	},
};
