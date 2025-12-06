const { REST } = require('discord.js');
const { Routes } = require('discord-api-types/v9');
require('dotenv').config();
const fs = require('fs');
const logger = require('./logger');

const globalCommands = [];
const guildCommands = {}; // guildId -> commands[]

const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
	const command = require(`./commands/${file}`);
	
	// Check if command is guild-specific
	if (command.guildOnly) {
		const guildId = command.guildOnly;
		if (!guildCommands[guildId]) {
			guildCommands[guildId] = [];
		}
		guildCommands[guildId].push(command.data.toJSON());
		logger.info(`Guild command: ${command.data.name} -> ${guildId}`);
	} else {
		globalCommands.push(command.data.toJSON());
	}
}

const rest = new REST({ version: '9' }).setToken(process.env.TOKEN);

(async () => {
	try {
		// Deploy global commands
		logger.info(`Deploying ${globalCommands.length} global commands...`);
		await rest.put(
			Routes.applicationCommands(process.env.CLIENT_ID),
			{ body: globalCommands },
		);
		logger.info('Successfully reloaded global commands.');

		// Deploy guild-specific commands
		for (const [guildId, commands] of Object.entries(guildCommands)) {
			logger.info(`Deploying ${commands.length} commands to guild ${guildId}...`);
			await rest.put(
				Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
				{ body: commands },
			);
			logger.info(`Successfully deployed to guild ${guildId}`);
		}

		logger.info('All commands deployed!');
	}
	catch (error) {
		logger.error(error.stack || error);
	}
})();