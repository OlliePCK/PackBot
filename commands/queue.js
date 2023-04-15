const { SlashCommandBuilder, MessageEmbed, MessageActionRow, MessageButton } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('queue')
		.setDescription('Show the current queue for music.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing playing!`);

		const row = new MessageActionRow()
			.addComponents(
				new MessageButton()
					.setCustomId('previous')
					.setLabel('Previous')
					.setStyle('SECONDARY'),
				new MessageButton()
					.setCustomId('next')
					.setLabel('Next')
					.setStyle('SECONDARY')
			);

		await interaction.editReply({
			ephemeral: true,
			embeds: [generateQueueEmbed(queue, interaction, 1)],
			components: [row],
		});

		const filter = (i) => i.user.id === interaction.user.id;

		const collector = interaction.channel.createMessageComponentCollector({ filter, time: 60000 });

		collector.on('collect', async (i) => {
			let currentPage = parseInt(i.message.embeds[0].footer.text.split(' ')[1]);

			if (i.customId === 'previous') {
				currentPage--;
			} else if (i.customId === 'next') {
				currentPage++;
			}

			await i.update({
				embeds: [generateQueueEmbed(queue, interaction, currentPage)],
			});
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

	const current = queue.songs.slice(startIndex, endIndex);
	let j = startIndex;
	const info = current.map(track => `\`${++j}.\` [${track.name}](${track.url}) - \`${track.formattedDuration}\``).join('\n');

	const embed = new MessageEmbed()
		.setTitle(`${interaction.client.emotes.play} | Now playing: ${queue.songs[0].name}`)
		.setURL(`${queue.songs[0].url}`)
		.setDescription(`${info}`)
		.addFields(
			{ name: 'Duration', value: `\`${queue.formattedDuration}\``, inline: true },
			{ name: 'Elapsed', value: `\`${queue.formattedCurrentTime}\``, inline: true },
			{ name: 'Volume', value: `\`${queue.volume}%\``, inline: true },
			{ name: 'Filter', value: `\`${queue.filters.names.join(', ') || 'Off'}\``, inline: true },
			{ name: 'Loop', value: `\`${queue.repeatMode ? queue.repeatMode === 2 ? 'All Queue' : 'This Song' : 'Off'}\``, inline: true },
			{ name: 'Autoplay', value: `\`${queue.autoplay ? 'On' : 'Off'}\``, inline: true },
		)
		.setFooter({
			text: 'The Pack',
			iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
		})
		.setColor('#ff006a');
		return embed;
}