const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('purge')
		.setDescription('Mass deletes messages (max 100).')
		.addIntegerOption(opt =>
			opt
				.setName('amount')
				.setDescription('Number of messages to delete (1–100)')
				.setRequired(true)
		),

	async execute(interaction, guildProfile) {
		const amount = interaction.options.getInteger('amount');

		if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | You need Administrator permissions to do that.`
			});
		}

		if (amount < 1 || amount > 100) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | Please specify a number between 1 and 100.`
			});
		}

		try {
			const deleted = await interaction.channel.bulkDelete(amount + 1, true);
			const count = deleted.size - 1;
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Purged Messages`)
				.setDescription(`Successfully deleted **${count}** message${count !== 1 ? 's' : ''}.`)
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		} catch (e) {
			console.error('Purge error:', e);
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | I couldn't delete those messages. ` +
					`Make sure I have the Manage Messages permission and the messages are under 14 days old.`
			});
		}
	},
};
