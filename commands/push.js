const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('push')
		.setDescription('Move a specified song to the 2nd entry in the queue, play it, and insert the skipped song after it.')
		.addIntegerOption(option =>
			option.setName('song_number')
				.setDescription('The position of the song in the queue that you want to move to the 2nd position.')
				.setRequired(true)),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);

		const songNumber = interaction.options.getInteger('song_number');
		if (isNaN(songNumber) || songNumber < 1 || songNumber > queue.songs.length) {
			return interaction.editReply(`${interaction.client.emotes.error} | Please enter a valid song number!`);
		}

		if (songNumber === 1) {
			await queue.skip();
		} else {
			const movedSong = queue.songs.splice(songNumber - 1, 1)[0];
			const currentSong = queue.songs[0];
			queue.songs.splice(1, 0, movedSong);
			queue.songs.splice(2, 0, currentSong);
			await queue.skip();
		}

		const embed = new EmbedBuilder()
			.setTitle(`${interaction.client.emotes.success} | Moved and playing: \`${queue.songs[1].name}\``)
			.addFields(
				{ name: 'Requested by', value: `${interaction.user}`, inline: true },
			)
			.setFooter({
				text: 'The Pack',
				iconURL: interaction.client.logo
			})
			.setColor('#ff006a');
		interaction.editReply({ embeds: [embed] });
	},
};
