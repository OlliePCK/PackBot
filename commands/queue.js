const { SlashCommandBuilder, MessageEmbed, ActionRowBuilder, ButtonBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	isEphemeral: true,
	data: new SlashCommandBuilder()
		.setName('queue')
		.setDescription('Show the current queue for music.'),
		async execute(interaction) {
			const queue = interaction.client.distube.getQueue(interaction);
			if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing playing!`);
		  
			const pageNumber = 1;
			const embed = generateQueueEmbed(queue, interaction, pageNumber);
		  
			if (!embed) return interaction.editReply(`${interaction.client.emotes.error} | Invalid page number.`);
		  
			const totalPages = Math.ceil(queue.songs.length / 10);
		  
			const row = new ActionRowBuilder()
			  .addComponents(
				new ButtonBuilder()
				  .setCustomId('previous')
				  .setLabel('Previous')
				  .setStyle(2)
				  .setDisabled(true),
				new ButtonBuilder()
				  .setCustomId('next')
				  .setLabel('Next')
				  .setStyle(2)
				  .setDisabled(totalPages <= 1), // Disable the button if there is only one page
			  );
		  
			await interaction.editReply({
			  ephemeral: true,
			  embeds: [embed],
			  components: [row],
			});
		  
			const filter = (i) => i.user.id === interaction.user.id;
		  
			const collector = interaction.channel.createMessageComponentCollector({ filter, time: 60000 });
		  
			collector.on('collect', async (i) => {
				let currentPage = parseInt(i.message.embeds[0].footer.text.split(' ')[1]);
			  
				if (i.customId === 'previous') {
				  currentPage--;
				  row.components[0].setDisabled(currentPage === 1);
				  row.components[1].setDisabled(false);
				} else if (i.customId === 'next') {
				  currentPage++;
				  row.components[0].setDisabled(false);
				  row.components[1].setDisabled(currentPage === totalPages);
				}
			  
				const embed = generateQueueEmbed(queue, interaction, currentPage);
			  
				if (!embed) return i.reply(`${interaction.client.emotes.error} | Invalid page number.` + currentPage);
			  
				try {
				  await i.update({
					embeds: [embed],
					ephemeral: true,
					components: [row],
				  });
				} catch (error) {
				  if (error.code === 10062) {
					await interaction.followUp({
					  ephemeral: true,
					  embeds: [embed],
					  components: [row],
					});
				  } else {
					console.error(error);
				  }
				}
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
	const info = "```" + current.map(track => `${++j}. ${track.name} (${track.formattedDuration})`).join('\n') + "```";

	if (!info) return;
	const embed = new EmbedBuilder()
		.setTitle(`${interaction.client.emotes.play} | Now playing: ${queue.songs[0].name}`)
		.setThumbnail(queue.songs[0].thumbnail)
		.setURL(`${queue.songs[0].url}`)
		.setDescription(`${info}`)
		.addFields(
			{ name: 'Duration', value: `\`${queue.formattedDuration}\u00A0\``, inline: true },
			{ name: 'Elapsed', value: `\`${queue.formattedCurrentTime}\u00A0\``, inline: true },
			{ name: 'Volume', value: `\`${interaction.client.emotes.volume}\u00A0${queue.volume}%\``, inline: true },
			{ name: 'Filter', value: `\`${interaction.client.emotes.filter}\u00A0${queue.filters.names.join(', ') || 'Off'}\``, inline: true },
			{ name: 'Loop', value: `\`${interaction.client.emotes.repeat}\u00A0${queue.repeatMode ? queue.repeatMode === 2 ? 'All Queue' : 'This Song' : 'Off'}\``, inline: true },
			{ name: 'Autoplay', value: `\`${interaction.client.emotes.autoplay}\u00A0${queue.autoplay ? 'On' : 'Off'}\``, inline: true }
		  )
		.setFooter({ text: `Page ${pageNumber} of ${totalPages} | The Pack`, iconURL: 'https://i.imgur.com/L49zHx9.jpg' })
		.setColor('#ff006a');
		return embed;
}
