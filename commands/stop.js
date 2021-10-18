const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('stop')
		.setDescription('Stops the currently playing music.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		queue.stop();
		interaction.editReply(`${interaction.client.emotes.success} | Stopped!`);
	},
};