const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('stop')
		.setDescription('Stops the currently playing music.'),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		queue.stop();
		const embed = new EmbedBuilder()
			.setTitle(`${interaction.client.emotes.success} | Music stopped!`)
			.setDescription('Thank you for using The Pack music bot.')
			.addFields(
				{ name: 'Requested by', value: `${interaction.user}`, inline: true },
			)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/L49zHx9.jpg'
			})
			.setColor('#ff006a');
		return interaction.editReply({ embeds: [embed] });
	},
};