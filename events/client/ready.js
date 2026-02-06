const youtubeNotifications = require('../../scripts/youtube-notifications');
const birthdayReminders = require('../../scripts/birthday-reminders');
const cookieMonitor = require('../../scripts/cookie-monitor');
const PageMonitorService = require('../../services/PageMonitorService');
const logger = require('../../logger').child('core');

module.exports = {
	name: 'clientReady',
	once: true,
	/**
	 * @param {import('discord.js').Client} client
	 */
	async execute(client) {
		logger.info(`Ready - logged in as ${client.user.tag}`);

		// 1) Set presence
		try {
			await client.user.setPresence({
				activities: [{ name: 'thepck.com' }],
				status: 'online'
			});
		} catch (e) {
			logger.error('Failed to set presence', { error: e.message });
		}

		// 2) Initialize YouTube notifications (event functions are loaded in index.js)
		try {
			await youtubeNotifications(client);
		} catch (e) {
			logger.error('Error initializing YouTube notifications', { error: e.message });
		}

		// 3) Initialize Birthday reminders
		try {
			birthdayReminders(client);
		} catch (e) {
			logger.error('Error initializing birthday reminders', { error: e.message });
		}

		// 4) Initialize Cookie expiration monitor
		try {
			cookieMonitor(client);
		} catch (e) {
			logger.error('Error initializing cookie monitor', { error: e.message });
		}

		// 5) Initialize Page Monitor Service
		try {
			client.pageMonitor = new PageMonitorService(client);
			await client.pageMonitor.start();
			logger.info('Page Monitor Service initialized');
		} catch (e) {
			logger.error('Error initializing Page Monitor Service', { error: e.message });
		}

		// 6) Setup graceful shutdown handlers
		setupShutdownHandlers(client);

		logger.info('All features initialized');
	}
};

/**
 * Setup graceful shutdown handlers for the bot
 * @param {import('discord.js').Client} client
 */
function setupShutdownHandlers(client) {
	let isShuttingDown = false;

	const shutdown = async (signal) => {
		if (isShuttingDown) return;
		isShuttingDown = true;

		logger.info(`Received ${signal}, shutting down gracefully...`);

		try {
			// Stop page monitor service (also closes browser client)
			if (client.pageMonitor) {
				await client.pageMonitor.stop();
				logger.info('Page Monitor Service stopped');
			}

			// Destroy the Discord client
			client.destroy();
			logger.info('Discord client destroyed');

			process.exit(0);
		} catch (error) {
			logger.error('Error during shutdown', { error: error.message });
			process.exit(1);
		}
	};

	// Handle various termination signals
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));

	// Handle uncaught exceptions gracefully
	process.on('uncaughtException', (error) => {
		logger.error('Uncaught exception', { error: error.message, stack: error.stack });
		shutdown('uncaughtException');
	});

	process.on('unhandledRejection', (reason, promise) => {
		logger.error('Unhandled rejection', { reason: String(reason) });
	});

	logger.debug('Shutdown handlers registered');
}

