const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const logger = require('../logger');

module.exports = {
	isEphemeral: true,
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
		try {
			const amount = interaction.options.getInteger('amount');

			if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
				const embed = new EmbedBuilder()
					.setDescription(`${interaction.client.emotes.error} | You need Administrator permissions to do that.`)
					.setColor('#ff0000')
					.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
				return interaction.editReply({ embeds: [embed] });
			}

			if (amount < 1 || amount > 100) {
				const embed = new EmbedBuilder()
					.setDescription(`${interaction.client.emotes.error} | Please specify a number between 1 and 100.`)
					.setColor('#ff0000')
					.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
				return interaction.editReply({ embeds: [embed] });
			}

			const deleted = await interaction.channel.bulkDelete(amount + 1, true);
			const count = deleted.size - 1;
			const embed = new EmbedBuilder()
				.setDescription(`🗑️ Deleted **${count}** message${count !== 1 ? 's' : ''}.`)
				.setColor('#00ff00')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

			return interaction.editReply({ embeds: [embed] });
		} catch (e) {
			logger.error('Purge error: ' + (e.stack || e));
			try {
				const embed = new EmbedBuilder()
					.setDescription(`${interaction.client.emotes.error} | Couldn't delete messages. Make sure I have permissions and messages are under 14 days old.`)
					.setColor('#ff0000')
					.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
				await interaction.editReply({ embeds: [embed] });
			} catch (editErr) {
				// Fallback if editReply fails (e.g., interaction expired)
				try {
					await interaction.followUp({
						content: `${interaction.client.emotes.error} | An unexpected error occurred while purging messages.`,
						flags: MessageFlags.Ephemeral
					});
				} catch (followErr) {
					logger.error('followUp also failed: ' + (followErr.stack || followErr));
				}
			}
		}
	},
};
