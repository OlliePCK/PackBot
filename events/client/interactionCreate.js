// events/interactionCreate.js
const db = require('../../database/db.js');
const { MessageFlags } = require('discord.js');
const logger = require('../../logger').child('commands');

// Simple in‑memory cache (you can swap this out for Redis later)
const guildCache = new Map();

module.exports = {
	name: 'interactionCreate',
	/**
	 * @param {import('discord.js').Interaction} interaction
	 */
	async execute(interaction) {
		if (!interaction.isCommand()) return;

		const command = interaction.client.commands.get(interaction.commandName);
		if (!command) return;

		try {
			// Defer the reply FIRST within 3 seconds
			await interaction.deferReply({ 
				flags: command.isEphemeral ? MessageFlags.Ephemeral : undefined 
			});

			// Load or upsert + fetch the guild profile
			let guildProfile = guildCache.get(interaction.guildId);
			if (!guildProfile) {
				await db.pool.query(
					`INSERT INTO Guilds (guildId)
			VALUES (?)
	         ON DUPLICATE KEY UPDATE guildId = guildId`,
					[interaction.guildId]
				);
				const [rows] = await db.pool.query(
					'SELECT * FROM Guilds WHERE guildId = ?',
					[interaction.guildId]
				);
				guildProfile = rows[0];
				guildCache.set(interaction.guildId, guildProfile);
			}

			// Execute the command, passing in the profile
			logger.command(interaction.commandName, interaction.user.tag, interaction.guild?.name || interaction.guildId);
			await command.execute(interaction, guildProfile);
		} catch (err) {
			logger.error('Command execution failed', {
				command: interaction.commandName,
				user: interaction.user.tag,
				guild: interaction.guild?.name || interaction.guildId,
				error: err.message
			});

			// Try to respond to the user
			try {
				if (interaction.deferred || interaction.replied) {
					await interaction.editReply({
						content: '❌ There was an error while executing this command.',
					});
				} else {
					await interaction.reply({
						content: '❌ There was an error while executing this command.',
						flags: MessageFlags.Ephemeral
					});
				}
			} catch (replyErr) {
				logger.error('Failed to send error message', { error: replyErr.message });
			}
		}
	},
};
