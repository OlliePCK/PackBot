const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('repeat')
		.setDescription('Set the repeat mode of the currently playing music.')
		.addStringOption(option => option.setName('mode').setDescription('Repeat modes').setRequired(true).addChoice('Queue repeat', 'queue').addChoice('Song repeat', 'song').addChoice('Repeat off', 'off')),
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
		interaction.editReply(`${interaction.client.emotes.repeat} | Set repeat mode to \`${mode}\``);
	},
};