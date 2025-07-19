const {
	SlashCommandBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	EmbedBuilder
} = require('discord.js');

module.exports = {
	isEphemeral: true,
	data: new SlashCommandBuilder()
		.setName('queue')
		.setDescription('Show the current music queue.'),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | There is nothing playing!`
			});
		}

		const totalPages = Math.ceil(queue.songs.length / 10);
		let currentPage = 1;

		// helper to build row
		const makeRow = page => new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId('prev_page')
				.setLabel('Previous')
				.setStyle(2)
				.setDisabled(page === 1),
			new ButtonBuilder()
				.setCustomId('next_page')
				.setLabel('Next')
				.setStyle(2)
				.setDisabled(page === totalPages)
		);

		// initial embed + row
		const embed = generateQueueEmbed(queue, interaction, currentPage);
		const row = makeRow(currentPage);

		await interaction.editReply({
			embeds: [embed],
			components: [row],
		});

		const filter = i => i.user.id === interaction.user.id;
		const collector = interaction.channel.createMessageComponentCollector({
			filter,
			time: 60_000
		});

		collector.on('collect', async i => {
			// adjust page
			if (i.customId === 'prev_page') currentPage--;
			else if (i.customId === 'next_page') currentPage++;

			// rebuild embed + buttons
			const newEmbed = generateQueueEmbed(queue, interaction, currentPage);
			const newRow = makeRow(currentPage);

			try {
				await i.update({
					embeds: [newEmbed],
					components: [newRow],
				});
			} catch (err) {
				console.error('Queue pagination error:', err);
			}
		});

		collector.on('end', async () => {
			// disable buttons after timeout
			const disabledRow = makeRow(currentPage)
				.components
				.map(b => b.setDisabled(true));
			try {
				await interaction.editReply({ components: [makeRow(currentPage)] });
			} catch { }
		});
	},
};

function generateQueueEmbed(queue, interaction, pageNumber) {
	const pageSize = 10;
	const totalSongs = queue.songs.length;
	const totalPages = Math.ceil(totalSongs / pageSize);
	const startIndex = (pageNumber - 1) * pageSize;
	const endIndex = Math.min(startIndex + pageSize, totalSongs);

	if (pageNumber < 1 || pageNumber > totalPages) return;

	const listing = queue.songs
		.slice(startIndex, endIndex)
		.map((song, i) => `**${startIndex + i + 1}.** ${song.name} (${song.formattedDuration})`)
		.join('\n');

	return new EmbedBuilder()
		.setTitle(`${interaction.client.emotes.play} | Now playing: ${queue.songs[0].name}`)
		.setURL(queue.songs[0].url)
		.setThumbnail(queue.songs[0].thumbnail)
		.setDescription(listing)
		.addFields(
			{ name: 'Duration', value: `\`${queue.formattedDuration}\``, inline: true },
			{ name: 'Elapsed', value: `\`${queue.formattedCurrentTime}\``, inline: true },
			{ name: 'Volume', value: `\`${queue.volume}%\``, inline: true },
			{ name: 'Filter', value: `\`${queue.filters.names.join(', ') || 'Off'}\``, inline: true },
			{ name: 'Loop', value: `\`${queue.repeatMode ? (queue.repeatMode === 2 ? 'All Queue' : 'This Song') : 'Off'}\``, inline: true },
			{ name: 'Autoplay', value: `\`${queue.autoplay ? 'On' : 'Off'}\``, inline: true },
		)
		.setFooter({ text: `Page ${pageNumber} of ${totalPages} | The Pack`, iconURL: interaction.client.logo })
		.setColor('#ff006a');
}
