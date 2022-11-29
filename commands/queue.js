const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('queue')
		.setDescription('Show the current queue for music.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.reply(`${interaction.client.emotes.error} | There is nothing playing!`);
		const channel = interaction.channel;
		const id = interaction.user.id;
		pages[id] = pages[id] || 0;
		embeds = generateQueueEmbed(queue, interaction);

		const embed = embeds[pages[id]];

		const filter = (i) => i.user.id === id;
		const time = 1000 * 60 * 5;

		interaction.reply({
			ephemeral: true,
			embeds: [embed],
			components: [getRow(id)]
		});

		const collector = channel.createMessageComponentCollector({ filter, time });
		collector.on('collect', (btnInt) => {
			if (!btnInt) {
				return;
			}

			btnInt.deferUpdate();

			if (btnInt.customId != 'prev_embed' && btnInt.customId != 'next_embed') {
				return;
			}

			if (btnInt.customId == 'prev_embed' && pages[id] > 0) {
				--pages[id];
			}
			else if (btnInt.customId == 'next_embed' && pages[id] < embeds.length - 1) {
				++pages[id];
			}

			interaction.editReply({
				embeds: [embeds[pages[id]]],
				components: [getRow(id)]
			});
		});
	},
};

const pages = {};
let embeds = [];

function getRow(id) {
	const row = new ActionRowBuilder();

	row.addComponents(
		new ButtonBuilder()
			.setCustomId('prev_embed')
			.setStyle(ButtonStyle.Secondary)
			.setEmoji('⏮️')
			.setDisabled(pages[id] === 0)
	);

	row.addComponents(
		new ButtonBuilder()
			.setCustomId('next_embed')
			.setStyle(ButtonStyle.Secondary)
			.setEmoji('⏭️')
			.setDisabled(pages[id] === embeds.length - 1)
	);

	return row;
}

function generateQueueEmbed(queue, interaction) {
	let k = 10;
	for (let i = 0; i < queue.songs.length; i += 10) {
		const current = queue.songs.slice(i, k);
		let j = i;
		k += 10;
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
		embeds.push(embed);
	}
	return embeds;
}