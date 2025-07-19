const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('undo')
		.setDescription('Removes the last song from the queue.'),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
			});
		}

		if (queue.songs.length <= 1) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | You can't undo the currently playing song!`
			});
		}

		try {
			// Remove the last song in the array
			const [removed] = queue.songs.splice(-1);

			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Removed from queue`)
				.setDescription(`🗑️ **${removed.name}** has been removed.`)
				.addFields({ name: 'Requested by', value: `${interaction.user}`, inline: true })
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		} catch (e) {
			console.error('Undo command error:', e);
			const errEmbed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | Couldn’t remove last song`)
				.setDescription('Something went wrong—please try again.')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [errEmbed] });
		}
	},
};
