const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('filters')
		.setDescription('Apply/turn off filters for the music.')
		.addStringOption(option => option.setName('filter').setDescription('Select from the valid filters above.').setRequired(true)
			.addChoices(
				{ name: 'off', value: 'off' },
				{ name: '3d', value: '3d' },
				{ name: '8D', value: '8D' },
				{ name: 'lowbass', value: 'lowbass' },
				{ name: 'clear', value: 'clear' },
				{ name: 'bassboost', value: 'bassboost' },
				{ name: 'echo', value: 'echo' },
				{ name: 'karaoke', value: 'karaoke' },
				{ name: 'nightcore', value: 'nightcore' },
				{ name: 'vaporwave', value: 'vaporwave' },
				{ name: 'flanger', value: 'flanger' },
				{ name: 'gate', value: 'gate' },
				{ name: 'haas', value: 'haas' },
				{ name: 'reverse', value: 'reverse' },
				{ name: 'surround', value: 'surround' },
				{ name: 'mcompand', value: 'mcompand' },
				{ name: 'phaser', value: 'phaser' },
				{ name: 'tremolo', value: 'tremolo' },
				{ name: 'off', value: 'off' },
				{ name: 'earwax', value: 'earwax' }

			)
		),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.reply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		if (interaction.options.getString('filter') === 'off' && queue.filters?.length) queue.setFilter(false);
		else if (Object.keys(interaction.client.distube.filters).includes(interaction.options.getString('filter'))) queue.setFilter(interaction.options.getString('filter'));
		else if (interaction.options.getString('filter')) return interaction.reply(`${interaction.client.emotes.error} | Not a valid filter`);
		const embed = new EmbedBuilder()
			.setTitle(`${interaction.client.emotes.success} | Filter set!`)
			.addFields(
				{ name: 'Filter:', value: `\`${queue.filters.names.join(', ') || 'Off'}\``, inline: true },
				{ name: 'Requested by', value: `${interaction.user}`, inline: true },
			)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		interaction.reply({ embeds: [embed] });
	},
};