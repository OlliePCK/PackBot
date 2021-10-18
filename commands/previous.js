const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('previous')
		.setDescription('Plays the previous song.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		try {
			const song = queue.previous();
			interaction.editReply(`${interaction.client.emotes.success} | Now playing:\n${song.name}`);
		}
		catch (e) {
			console.log(e);
			interaction.editReply(`${interaction.client.emotes.error} | An error occured, please try again!`);
		}
	},
};