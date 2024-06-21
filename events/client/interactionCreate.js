const db = require('../../database/db.js');
module.exports = {
	name: 'interactionCreate',
	/**
	 * Executes the command associated with the interaction.
	 * @param {Interaction} interaction - The interaction object.
	 * @returns {Promise<void>} - A promise that resolves once the command execution is complete.
	 */
	async execute(interaction) {
		if (!interaction.isCommand()) return;

		const command = interaction.client.commands.get(interaction.commandName);

		if (!command) return;

		try {
			if (command.isEphemeral) {
				await interaction.deferReply({ ephemeral: true }); // Add this line to defer the reply
				await command.execute(interaction);
			}
			else {
				await interaction.deferReply(); // Add this line to defer the reply
				await command.execute(interaction);
			}
		}
		catch (error) {
			console.log(error);
			await interaction.editReply({ content: 'There was an error while executing this command!', ephemeral: true });
		}

		const connection = await db.pool.getConnection();

		// Try to find the guild profile
		const [rows] = await connection.query('SELECT * FROM Guilds WHERE guildId = ?', [interaction.guildId]);
		let guildProfile = rows[0];

		if (!guildProfile) {
			// Guild profile not found, create a new one
			const result = await connection.query('INSERT INTO Guilds (guildId) VALUES (?)', [interaction.guildId]);
			const insertId = result[0].insertId;

			// Fetch the newly created guild profile
			const [newRows] = await connection.query('SELECT * FROM Guilds WHERE id = ?', [insertId]);
			guildProfile = newRows[0];
		}
	},
};
