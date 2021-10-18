const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('pause')
		.setDescription('Pauses the currently playing music.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		if (queue.pause) {
			queue.resume();
			return interaction.editReply('The song has been resumed!');
		}
		queue.pause();
		interaction.editReply('The song has been paused!');
	},
};