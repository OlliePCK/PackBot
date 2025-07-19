const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('skip')
		.setDescription('Skips the currently playing music.'),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
			});
		}

		try {
			// Attempt to skip; if there's no next song, this will throw
			await queue.skip();
		} catch (e) {
			console.warn('Skip failed, stopping instead:', e);
			// Fallback: stop playback entirely
			await queue.stop();
		}

		const embed = new EmbedBuilder()
			.setTitle(`${interaction.client.emotes.success} | Song skipped!`)
			.addFields({ name: 'Requested by', value: `${interaction.user}`, inline: true })
			.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
			.setColor('#ff006a');

		return interaction.editReply({ embeds: [embed] });
	},
};
