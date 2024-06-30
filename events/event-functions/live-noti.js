const db = require('../../database/db.js');
module.exports = client => {
	client.on('presenceUpdate', async (oldPresence, newPresence) => {
		const Guild = newPresence.guild;

		if (Guild == undefined | Guild == null) {
			return;
		}

		const connection = await db.pool.getConnection();
		try {
			const [rows] = await connection.query('SELECT * FROM Guilds WHERE guildId = ?', [Guild.id]);
			const guildProfile = rows[0];
			if (!guildProfile) return;

			if (!guildProfile.liveRoleID) return;
			const liverole = guildProfile.liveRoleID;

			if (!guildProfile.liveChannelID) return;
			const live = guildProfile.liveChannelID;

			if (oldPresence == undefined) {
				return;
			}
			const oldStreamingStatus = oldPresence.activities.find(activity => activity.type === 1) ? true : false;
			const newStreamingStatus = newPresence.activities.find(activity => activity.type === 1) ? true : false;
			const discName = newPresence.user.username;
			if (newStreamingStatus === true && oldStreamingStatus === false) {
				const streamURL = newPresence.activities.find(activity => activity.type === 1).url;
				console.log(`${discName}, just went live!`);
				newPresence.member.roles.add(liverole).catch(() => {
					return client.channels.cache.get(live).send('An error occured adding the live role to the user! Please ensure **The Pack** bot role is higher than all users!').catch(console.error);
				});
				return client.channels.cache.get(live).send(`**${discName}** just went live! Watch: ${streamURL}`).catch(console.error);
			}
			else if (oldStreamingStatus === true && newStreamingStatus === false) {
				newPresence.member.roles.remove(liverole).catch(() => {
					return client.channels.cache.get(live).send('An error occured removing the live role to the user! Please ensure **The Pack** bot role is higher than all users!').catch(console.error);
				});
				return console.log(`${discName}, just stopped streaming.`);
			}
		} catch (error) {
			return console.error(error);
		}
	});
};