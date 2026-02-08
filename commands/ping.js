const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('ping')
		.setDescription('Replies with Pong!'),

	async execute(interaction, guildProfile) {
		const embed = new EmbedBuilder()
			.setDescription('🏓 Pong!')
			.setColor('#ff006a')
			.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
		return interaction.editReply({ embeds: [embed] });
	},
};
