const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('queue')
		.setDescription('Show the current queue for music.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.reply(`${interaction.client.emotes.error} | There is nothing playing!`);
		return interaction.reply({
			ephemeral: true,
			embeds: [generateQueueEmbed(queue, interaction)],
		});
	},
};


function generateQueueEmbed(queue, interaction) {
	const current = queue.songs.slice(0, 10);
	let j = 0;
	const info = current.map(track => `\`${++j}.\` [${track.name}](${track.url}) - \`${track.formattedDuration}\``).join('\n');
	const embed = new EmbedBuilder()
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