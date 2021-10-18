const { SlashCommandBuilder } = require('@discordjs/builders');


module.exports = {
	data: new SlashCommandBuilder()
		.setName('filters')
		.setDescription('Apply/turn off filters for the music.')
		.addStringOption(option => option.setName('filter').setDescription('off, 3d, bassboost, vaporwave, echo, karaoke, nightcore, flanger, gate, haas, reverse, phaser').setRequired(true)),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		if (interaction.options.getString('filter') === 'off' && queue.filters?.length) queue.setFilter(false);
		else if (Object.keys(interaction.client.distube.filters).includes(interaction.options.getString('filter'))) queue.setFilter(interaction.options.getString('filter'));
		else if (interaction.options.getString('filter')) return interaction.editReply(`${interaction.client.emotes.error} | Not a valid filter`);
		interaction.editReply(`Current Queue Filter: \`${queue.filters.join(', ') || 'Off'}\``);
	},
};