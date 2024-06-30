const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('swap')
		.setDescription('Swap the positions of two songs in the queue.')
		.addIntegerOption(option =>
			option.setName('song_position_1')
				.setDescription('The position of the first song in the queue to be swapped.')
				.setRequired(true))
		.addIntegerOption(option =>
			option.setName('song_position_2')
				.setDescription('The position of the second song in the queue to be swapped.')
				.setRequired(true)),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);

		const songPosition1 = interaction.options.getInteger('song_position_1');
		const songPosition2 = interaction.options.getInteger('song_position_2');

		if (isNaN(songPosition1) || isNaN(songPosition2) || songPosition1 < 1 || songPosition1 > queue.songs.length || songPosition2 < 1 || songPosition2 > queue.songs.length) {
			return interaction.editReply(`${interaction.client.emotes.error} | Please enter valid song positions!`);
		}

		if (songPosition1 === songPosition2) {
			return interaction.editReply(`${interaction.client.emotes.error} | Both song positions are the same, no swap is needed.`);
		}

		if (songPosition1 === 1 || songPosition2 === 1) {
			const otherPosition = songPosition1 === 1 ? songPosition2 : songPosition1;
			const currentSong = queue.songs[0];
			const tempSong = queue.songs[otherPosition - 1];
			queue.songs.splice(otherPosition - 1, 1);
			queue.songs.splice(1, 0, tempSong);
			queue.songs.splice(otherPosition, 0, currentSong);
			await queue.skip();
		} else {
			[queue.songs[songPosition1 - 1], queue.songs[songPosition2 - 1]] = [queue.songs[songPosition2 - 1], queue.songs[songPosition1 - 1]];
		}

		const embed = new EmbedBuilder()
			.setTitle(`${interaction.client.emotes.success} | Swapped songs in the queue`)
			.setDescription(`Swapped positions \`${songPosition1}\` and \`${songPosition2}\`.`)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/L49zHx9.jpg'
			})
			.setColor('#ff006a');
		interaction.editReply({ embeds: [embed] });
	},
};
