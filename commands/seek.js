const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('seek')
		.setDescription('Skip to a certain point in the song.')
		.addIntegerOption(opt =>
			opt
				.setName('time')
				.setDescription('Number of seconds to seek')
				.setRequired(true)
		),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
			});
		}

		const time = interaction.options.getInteger('time');
		const currentSong = queue.songs[0];
		// Validate within song duration
		if (time < 0 || time > currentSong.duration) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | Please enter a time between 0 and ${currentSong.duration} seconds.`
			});
		}

		try {
			// DisTube’s seek() returns a promise
			await queue.seek(time);

			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Seeked to ${time}s!`)
				.addFields(
					{ name: 'Requested by', value: `${interaction.user}`, inline: true },
					{ name: 'Elapsed', value: `\`${queue.formattedCurrentTime}\``, inline: true },
				)
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		} catch (e) {
			console.error('Seek error:', e);
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | An error occurred while seeking—please try again!`
			});
		}
	},
};
