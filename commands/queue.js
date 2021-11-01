const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');
const { pagination } = require('reconlx');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('queue')
		.setDescription('Show the current queue for music.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		const channel = interaction.channel;
		const author = interaction.member.user;
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing playing!`);
		await interaction.editReply('Fetching queue...');
		await interaction.deleteReply();
		const embeds = generateQueueEmbed(queue, interaction);
		pagination({
			embeds: embeds,
			time: 20000,
			channel: channel,
			author: author,
		});
	},
};

function generateQueueEmbed(queue, interaction) {
	const embeds = [];
	let k = 10;
	for (let i = 0; i < queue.songs.length; i += 10) {
		const current = queue.songs.slice(i, k);
		let j = i;
		k += 10;
		const info = current.map(track => `\`${++j}.\` [${track.name}](${track.url}) - \`${track.formattedDuration}\``).join('\n');
		const embed = new MessageEmbed()
			.setTitle(`${interaction.client.emotes.play} | Now playing: ${queue.songs[0].name}`)
			.setURL(`${queue.songs[0].url}`)
			.setDescription(`${info}`)
			.addFields(
				{ name: 'Duration', value: `\`${queue.formattedDuration}\``, inline: true },
				{ name: 'Elapsed', value: `\`${queue.formattedCurrentTime}\``, inline: true },
				{ name: 'Volume', value: `\`${queue.volume}%\``, inline: true },
				{ name: 'Filter', value: `\`${queue.filters.join(', ') || 'Off'}\``, inline: true },
				{ name: 'Loop', value: `\`${queue.repeatMode ? queue.repeatMode === 2 ? 'All Queue' : 'This Song' : 'Off'}\``, inline: true },
				{ name: 'Autoplay', value: `\`${queue.autoplay ? 'On' : 'Off'}\``, inline: true },
			)
			.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
			.setColor('#ff006a');
		embeds.push(embed);
	}
	return embeds;
}