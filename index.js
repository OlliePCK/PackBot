const fs = require('fs');
const path = require('path');
const logger = require('./logger').child('core');
const { Client, Collection, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const config = require('./config.json');
require('dotenv').config();

// Clean up any stray yt-dlp temp files on startup
const cleanupTempFiles = () => {
	const patterns = ['--Frag', '.part', '.ytdl'];
	try {
		const files = fs.readdirSync(__dirname);
		for (const file of files) {
			if (patterns.some(p => file.includes(p))) {
				fs.unlinkSync(path.join(__dirname, file));
				logger.info(`Cleaned up temp file: ${file}`);
			}
		}
	} catch (err) {
		// Ignore cleanup errors
	}
};
cleanupTempFiles();

// Set yt-dlp path
// In Docker, YTDLP_PATH is set via environment variable.
// On Windows, use the WinGet installation path.
if (!process.env.YTDLP_PATH) {
	const ytdlpPath = 'C:\\Users\\Ollie\\AppData\\Local\\Microsoft\\WinGet\\Packages\\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\\yt-dlp.exe';
	if (fs.existsSync(ytdlpPath)) {
		process.env.YTDLP_PATH = ytdlpPath;
		logger.info('Using Windows yt-dlp: ' + ytdlpPath);
	} else {
		logger.info('Using system yt-dlp');
	}
} else {
	logger.info('Using yt-dlp from YTDLP_PATH: ' + process.env.YTDLP_PATH);
}

// Set yt-dlp config file location
process.env.XDG_CONFIG_HOME = __dirname;

// Suppress punycode deprecation warning
process.removeAllListeners('warning');
process.on('warning', (warning) => {
	if (warning.name === 'DeprecationWarning' && warning.message.includes('punycode')) {
		return; // Ignore punycode warnings
	}
	logger.warn(warning.message);
});

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildPresences,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildVoiceStates,
	],
});

client.emotes = config.emoji;
client.logo = config.logo;

// Music System
client.subscriptions = new Map();

client.commands = new Collection();
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
const eventFiles = fs.readdirSync('./events/client').filter(file => file.endsWith('.js'));
const eventFunctions = fs.readdirSync('./events/event-functions').filter(file => file.endsWith('.js'));


for (const file of commandFiles) {
	const command = require(`./commands/${file}`);
	// Set a new item in the Collection
	// With the key as the command name and the value as the exported module
	client.commands.set(command.data.name, command);
}

for (const file of eventFiles) {
	const event = require(`./events/client/${file}`);
	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args));
	}
	else {
		client.on(event.name, (...args) => event.execute(...args));
	}
}

// Initialize event functions (these export a function that takes client)
for (const file of eventFunctions) {
	const initFunction = require(`./events/event-functions/${file}`);
	if (typeof initFunction === 'function') {
		// These modules export a function that sets up their own event listeners
		initFunction(client);
	} else if (initFunction.name && initFunction.execute) {
		// Standard event module format
		if (initFunction.once) {
			client.once(initFunction.name, (...args) => initFunction.execute(...args));
		} else {
			client.on(initFunction.name, (...args) => initFunction.execute(...args));
		}
	}
}

logger.info('Starting PackBot...');

// Global error handlers to prevent crashes
process.on('unhandledRejection', (error) => {
	logger.error('Unhandled promise rejection', { error: error?.message || String(error), stack: error?.stack });
});

process.on('uncaughtException', (error) => {
	logger.error('Uncaught exception', { error: error?.message || String(error), stack: error?.stack });
});

// Handle Discord client errors
client.on('error', (error) => {
	logger.error('Discord client error', { error: error?.message || String(error) });
});

client.login(process.env.TOKEN).then(() => logger.info('Client logged in successfully')).catch(err => logger.error('Login failed', { error: err.message }));
