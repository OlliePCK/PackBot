const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('resume')
		.setDescription('Resume the currently paused song.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		try {
			queue.resume();
			interaction.editReply('The music has been resumed!');
		}
		catch (e) {
			console.log(e);
			interaction.editReply(`${interaction.client.emotes.error} | An error occured, please try again!`);
		}
	},
};