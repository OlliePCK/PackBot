const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('autoplay')
		.setDescription('Toggles the autoplay of music after the queue finishes.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		try {
			const autoplay = queue.toggleAutoplay();
			interaction.editReply(`${interaction.client.emotes.success} | AutoPlay: \`${autoplay ? 'On' : 'Off'}\``);
		}
		catch (e) {
			console.log(e);
			interaction.editReply(`${interaction.client.emotes.error} | An error occured, please try again!`);
		}
	},
};