// events/presenceUpdate.js
const db = require('../../database/db.js');

module.exports = client => {
	// In‑memory cache of guild → generalChannelID
	const guildChannels = new Map();

	// Helper to load & cache a guild’s channel
	async function getGeneralChannel(guildId) {
		if (guildChannels.has(guildId)) return guildChannels.get(guildId);
		const [rows] = await db.pool.query(
			'SELECT generalChannelID FROM Guilds WHERE guildId = ?',
			[guildId]
		);
		const channelId = rows[0]?.generalChannelID ?? null;
		guildChannels.set(guildId, channelId);
		return channelId;
	}

	// Track when someone started an “activity with timestamps”
	const startTimes = new Map(); // key = userId + activityName, value = Date

	client.on('presenceUpdate', (oldP, newP) => {
		// 1) Must have both presences and a guild
		if (!oldP?.guild || !newP?.guild) return;

		// 2) Find any activity that has a `timestamps.start`
		const oldAct = oldP.activities.find(a => a.timestamps?.start);
		const newAct = newP.activities.find(a => a.name === oldAct?.name);

		// 3) If they *started* playing it, record the time
		if (!oldAct && newAct) {
			startTimes.set(
				`${newP.userId}|${newAct.name}`,
				newAct.timestamps.start
			);
			return;
		}

		// 4) If they *stopped* playing it, see how long
		if (oldAct && !newAct) {
			const key = `${newP.userId}|${oldAct.name}`;
			const start = startTimes.get(key);
			if (!start) return startTimes.delete(key);

			const hours = (Date.now() - start) / 36e5;
			startTimes.delete(key);

			if (hours < 6) return;

			// 5) Lookup the general channel once & send
			getGeneralChannel(newP.guild.id).then(chId => {
				if (!chId) return;
				const chan = client.channels.cache.get(chId);
				if (chan?.isText()) {
					chan.send(
						`${newP.user.tag} played **${oldAct.name}** for ${hours.toFixed(2)} hours!`
					).catch(console.error);
				}
			}).catch(console.error);
		}
	});
};
