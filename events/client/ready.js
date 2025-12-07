const youtubeNotifications = require('../../scripts/youtube-notifications');
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

		// 3) Initialize Page Monitor Service
		try {
			client.pageMonitor = new PageMonitorService(client);
			await client.pageMonitor.start();
			logger.info('Page Monitor Service initialized');
		} catch (e) {
			logger.error('Error initializing Page Monitor Service', { error: e.message });
		}

		logger.info('All features initialized');
	}
};

