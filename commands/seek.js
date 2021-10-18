const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('seek')
		.setDescription('Skip to a certain point in the song.')
		.addIntegerOption(option =>
			option.setName('time')
				.setDescription('Number of seconds to seek')
				.setRequired(true)),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		const time = Number(interaction.options.getInteger('time'));
		if (isNaN(time)) return interaction.editReply(`${interaction.client.emotes.error} | Please enter a valid number!`);
		try {
			queue.seek(time);
			interaction.editReply(`Seeked to ${time} seconds/!`);
		}
		catch (e) {
			console.log(e);
			interaction.editReply(`${interaction.client.emotes.error} | An error occured, please try again!`);
		}
	},
};