const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('skip')
		.setDescription('Stops the currently playing music.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		try {
			interaction.editReply(`${interaction.client.emotes.success} | Skipped this song!`);
		}
		catch (e) {
			console.log(e);
			interaction.editReply(`${interaction.client.emotes.error} | There are no more songs in the queue!`);
		}
	},
};