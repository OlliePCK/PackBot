const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('stop')
		.setDescription('Stops the currently playing music.'),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
			});
		}

		try {
			// Stop playback and clear the queue
			queue.stop();

			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Music stopped!`)
				.setDescription('Thank you for using The Pack music bot.')
				.addFields({ name: 'Requested by', value: `${interaction.user}`, inline: true })
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		} catch (e) {
			console.error('Stop command error:', e);
			const errEmbed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | Couldn’t stop playback`)
				.setDescription('Something went wrong—please try again.')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [errEmbed] });
		}
	},
};
