const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('volume')
		.setDescription('Set the volume level of the audio player')
		.addIntegerOption(option =>
			option.setName('volume')
				.setDescription('Volume level out of 100')
				.setRequired(true)),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		const volume = parseInt(interaction.options.getInteger('volume'));
		if (isNaN(volume)) return interaction.editReply(`${interaction.client.emotes.error} | Please enter a valid number!`);
		try {
			queue.setVolume(volume);
			interaction.editReply(`${interaction.client.emotes.success} | Volume set to \`${volume}\``);
		}
		catch (e) {
			console.log(e);
			interaction.editReply(`${interaction.client.emotes.error} | An error occured, please try again!`);
		}
	},
};