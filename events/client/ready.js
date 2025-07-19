const youtubeNotifications = require('../../scripts/youtube-notifications');
const gameExpose = require('../event-functions/game-expose');
const liveNoti = require('../event-functions/live-noti');

module.exports = {
	name: 'ready',
	once: true,
	/**
	 * @param {import('discord.js').Client} client
	 */
	async execute(client) {
		console.log(`✅ Ready! Logged in as ${client.user.tag}`);

		// 1) Set presence
		try {
			await client.user.setPresence({
				activities: [{ name: 'thepck.com' }],
				status: 'online'
			});
		} catch (e) {
			console.error('Failed to set presence:', e);
		}

		// 2) Initialize all subsystems in parallel
		try {
			await Promise.all([
				require('../event-functions/game-expose')(client),
				require('../event-functions/live-noti')(client),
				require('../../scripts/youtube-notifications')(client)
			]);
			console.log('🚀 All features initialized.');
		} catch (e) {
			console.error('Error initializing features:', e);
		}
	}
};

