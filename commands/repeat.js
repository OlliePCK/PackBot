const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('repeat')
		.setDescription('Set the repeat mode of the currently playing music.')
		.addStringOption(option => option.setName('mode').setDescription('Repeat modes').setRequired(true)
			.addChoices(
				{ name: 'Queue repeat', value: 'queue' },
				{ name: 'Song repeat', value: 'song' },
				{ name: 'Repeat off', value: 'off' }
			)
		),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
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
		const embed = new EmbedBuilder()
			.setTitle(`${interaction.client.emotes.success} | Set the repeat mode: \`${mode}\``)
			.addFields(
				{ name: 'Requested by', value: `${interaction.user}`, inline: true },
			)
			.setFooter({
				text: 'The Pack',
				iconURL: interaction.client.logo
			})
			.setColor('#ff006a');
		return interaction.editReply({ embeds: [embed] });
	},
};