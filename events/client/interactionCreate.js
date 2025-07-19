// events/interactionCreate.js
const db = require('../../database/db.js');

// Simple in‑memory cache (you can swap this out for Redis or similar later)
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

		// Defer the reply once, with the correct ephemeral flag
		await interaction.deferReply({ ephemeral: !!command.isEphemeral });

		// 1) Load from cache or 2) Upsert + fetch
		let guildProfile = guildCache.get(interaction.guildId);
		if (!guildProfile) {
			// UPSERT style insert (MySQL syntax) — assumes `guildId` is UNIQUE
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

		try {
			// Pass guildProfile into your command handler
			await command.execute(interaction, guildProfile);
		} catch (err) {
			console.error('Command error:', err);
			// If you already replied, use editReply; else fallback to reply
			const method = interaction.deferred ? 'editReply' : 'reply';
			await interaction[method]({
				content: '❌ There was an error while executing this command.',
				ephemeral: true
			});
		}
	},
};
