const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('filters')
		.setDescription('Apply/turn off filters for the music.')
		.addStringOption(option => option.setName('filter').setDescription('Select from the valid filters above.').setRequired(true)
			.addChoice('off', 'off')
			.addChoice('3d', '3d')
			.addChoice('8D', '8D')
			.addChoice('lowbass', 'lowbass')
			.addChoice('clear', 'clear')
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
		const embed = new MessageEmbed()
			.setTitle(`${interaction.client.emotes.success} | Filter set!`)
			.addFields(
				{ name: 'Filter:', value: `\`${queue.filters.join(', ') || 'Off'}\``, inline: true },
				{ name: 'Requested by', value: `${interaction.user}`, inline: true },
			)
			.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
			.setColor('#ff006a');
		interaction.editReply({ embeds: [embed] });
	},
};