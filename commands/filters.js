const { SlashCommandBuilder } = require('@discordjs/builders');


module.exports = {
	data: new SlashCommandBuilder()
		.setName('filters')
		.setDescription('Apply/turn off filters for the music.')
		.addStringOption(option => option.setName('filter').setDescription('Select from the valid filters above.').setRequired(true)
			.addChoice('3d', '3d')
			.addChoice('bassboost', 'bassboost')
			.addChoice('echo', 'echo')
			.addChoice('karaoke', 'karaoke')
			.addChoice('nightcore', 'nightcore')
			.addChoice('vaporwave', 'vaporwave')
			.addChoice('flanger', 'flanger')
			.addChoice('gate', 'gate')
			.addChoice('haas', 'haas')
			.addChoice('reverse', 'reverse')
			.addChoice('surround', 'surround')
			.addChoice('mcompand', 'mcompand')
			.addChoice('phaser', 'phaser')
			.addChoice('tremolo', 'tremolo')
			.addChoice('earwax', 'earwax'),
		),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		if (interaction.options.getString('filter') === 'off' && queue.filters?.length) queue.setFilter(false);
		else if (Object.keys(interaction.client.distube.filters).includes(interaction.options.getString('filter'))) queue.setFilter(interaction.options.getString('filter'));
		else if (interaction.options.getString('filter')) return interaction.editReply(`${interaction.client.emotes.error} | Not a valid filter`);
		interaction.editReply(`Current Queue Filter: \`${queue.filters.join(', ') || 'Off'}\``);
	},
};