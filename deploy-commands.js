const { REST } = require('discord.js');
const { Routes } = require('discord-api-types/v9');
require('dotenv').config();
const fs = require('fs');
const logger = require('./logger');

const commands = [];
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
	const command = require(`./commands/${file}`);
	commands.push(command.data.toJSON());
}

const rest = new REST({ version: '9' }).setToken(process.env.TOKEN);

(async () => {
	try {
		logger.info('Started refreshing application (/) commands.');

		await rest.put(
			Routes.applicationCommands(process.env.CLIENT_ID),
			{ body: commands },
		);

		logger.info('Successfully reloaded application (/) commands.');
	}
	catch (error) {
		logger.error(error.stack || error);
	}
})();