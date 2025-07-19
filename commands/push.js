const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('push')
		.setDescription('Move a specified song to the 2nd entry in the queue, play it, and insert the skipped song after it.')
		.addIntegerOption(option =>
			option
				.setName('song_number')
				.setDescription('The position in the queue (1 = current, 2 = next, …)')
				.setRequired(true)
		),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
			});
		}

		const songNumber = interaction.options.getInteger('song_number');
		const len = queue.songs.length;
		if (songNumber < 1 || songNumber > len) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | Please enter a valid song number between 1 and ${len}!`
			});
		}

		try {
			if (songNumber === 1) {
				// If they chose the current song, just skip it
				await queue.skip();
			} else {
				// Remove the chosen song, insert it second, then re-add the current track after it
				const movedSong = queue.songs.splice(songNumber - 1, 1)[0];
				const current = queue.songs[0];
				queue.songs.splice(1, 0, movedSong);
				queue.songs.splice(2, 0, current);
				await queue.skip();
			}

			// After skip, queue.songs[1] is the one we just moved into position 2
			const nowPlaying = queue.songs[1];
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Moved and playing:`)
				.setDescription(`▶️ Now playing **${nowPlaying.name}**`)
				.addFields({ name: 'Requested by', value: `${interaction.user}`, inline: true })
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		} catch (e) {
			console.error('Push command error:', e);
			const errEmbed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | Couldn’t push that song`)
				.setDescription('Something went wrong—please try again.')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [errEmbed] });
		}
	},
};
