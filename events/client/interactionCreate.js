// events/interactionCreate.js
const { getGuildRow } = require('../../database/guilds');
const { MessageFlags } = require('discord.js');
const logger = require('../../logger').child('commands');

// Guild cache with TTL (5 minutes)
const CACHE_TTL = 5 * 60 * 1000;
const guildCache = new Map(); // { guildId: { data, timestamp } }

// Export cache for clearing from other modules (e.g., settings.js)
module.exports.guildCache = guildCache;

// Commands/subcommands that should not be deferred (e.g., modal commands)
const NO_DEFER_COMMANDS = new Set([
	'movie:login', // Shows a modal
]);

module.exports = {
	name: 'interactionCreate',
	/**
	 * @param {import('discord.js').Interaction} interaction
	 */
	async execute(interaction) {
		// Handle modal submissions
		if (interaction.isModalSubmit()) {
			// Try to find a command that handles this modal
			for (const [, command] of interaction.client.commands) {
				if (typeof command.handleModalSubmit === 'function') {
					try {
						const handled = await command.handleModalSubmit(interaction);
						if (handled) return;
					} catch (err) {
						logger.error('Modal handler error', { customId: interaction.customId, error: err.message });
					}
				}
			}
			return;
		}

		// Handle autocomplete interactions
		if (interaction.isAutocomplete()) {
			const command = interaction.client.commands.get(interaction.commandName);
			if (command && typeof command.autocomplete === 'function') {
				try {
					await command.autocomplete(interaction);
				} catch (err) {
					logger.error('Autocomplete error', { command: interaction.commandName, error: err.message });
				}
			}
			return;
		}

		if (!interaction.isCommand()) return;

		const command = interaction.client.commands.get(interaction.commandName);
		if (!command) return;

		try {
			// Check if this command should skip deferring (e.g., shows a modal)
			const subcommand = interaction.options?.getSubcommand?.(false);
			const commandKey = subcommand ? `${interaction.commandName}:${subcommand}` : interaction.commandName;
			const shouldDefer = !NO_DEFER_COMMANDS.has(commandKey);

			// Defer the reply FIRST within 3 seconds (unless it shows a modal)
			if (shouldDefer) {
				await interaction.deferReply({
					flags: command.isEphemeral ? MessageFlags.Ephemeral : undefined
				});
			}

			// Load or upsert + fetch the guild profile (with TTL check)
			const cached = guildCache.get(interaction.guildId);
			let guildProfile = null;
			if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
				guildProfile = cached.data;
			}
			if (!guildProfile) {
				guildProfile = await getGuildRow(interaction.guildId);
				guildCache.set(interaction.guildId, { data: guildProfile, timestamp: Date.now() });
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
