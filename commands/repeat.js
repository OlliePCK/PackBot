const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('repeat')
		.setDescription('Set the repeat mode of the currently playing music.')
		.addStringOption(option => option.setName('mode').setDescription('Repeat modes').setRequired(true).addChoice('Queue repeat', 'queue').addChoice('Song repeat', 'song').addChoice('Repeat off', 'off')),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.reply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		let mode = null;
		switch (interaction.options.getString('mode')) {
		case 'off':
			mode = 0;
			break;
		case 'song':
			mode = 1;
			break;
		case 'queue':
			mode = 2;
			break;
		}
		mode = queue.setRepeatMode(mode);
		mode = mode ? mode === 2 ? 'Repeat queue' : 'Repeat song' : 'Off';
		const embed = new MessageEmbed()
			.setTitle(`${interaction.client.emotes.success} | Set the repeat mode: \`${mode}\``)
			.addFields(
				{ name: 'Requested by', value: `${interaction.user}`, inline: true },
			)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		return interaction.reply({ embeds: [embed] });
	},
};