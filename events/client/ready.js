const youtubeNotifications = require('../../scripts/youtube-notifications');
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
			logger.info('All features initialized');
		} catch (e) {
			logger.error('Error initializing features', { error: e.message });
		}
	}
};

