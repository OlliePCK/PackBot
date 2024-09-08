const db = require('../../database/db.js');
module.exports = client => {
	client.on('presenceUpdate', async (oldPresence, newPresence) => {
		const Guild = newPresence.guild;

		if (Guild == undefined | Guild == null) {
			return;
		}

		try {
			if (oldPresence == undefined) {
				return;
			}
			const oldStreamingStatus = oldPresence.activities.find(activity => activity.type === 1) ? true : false;
			const newStreamingStatus = newPresence.activities.find(activity => activity.type === 1) ? true : false;
			const discName = newPresence.user.username;
			if (newStreamingStatus === true && oldStreamingStatus === false) {
				const [rows] = await db.pool.query('SELECT * FROM Guilds WHERE guildId = ?', [Guild.id]);
				const guildProfile = rows[0];
				if (!guildProfile) return;

				if (!guildProfile.liveRoleID) return;
				const liverole = guildProfile.liveRoleID;

				if (!guildProfile.liveChannelID) return;
				const live = guildProfile.liveChannelID;
				const streamURL = newPresence.activities.find(activity => activity.type === 1).url;
				console.log(`${discName}, just went live!`);
				newPresence.member.roles.add(liverole).catch(() => {
					return client.channels.cache.get(live).send('An error occured adding the live role to the user! Please ensure **The Pack** bot role is higher than all users!').catch(console.error);
				});
				client.channels.cache.get(live).send(`**${discName}** just went live! Watch: ${streamURL}`).catch(console.error);
				if (newPresence.member.voice.channel) {
					const voiceChannelID = newPresence.member.voice.channelId;
					await fetch(`https://discord.com/api/v10/channels/${voiceChannelID}/voice-status`, {
						method: 'POST',
						headers: {
							Authorization: `Bot ${process.env.TOKEN}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							status: 'LIVE STREAMING 🔴',
						}),
					});
				}
			}
			else if (oldStreamingStatus === true && newStreamingStatus === false) {
				const [rows] = await db.pool.query('SELECT * FROM Guilds WHERE guildId = ?', [Guild.id]);
				const guildProfile = rows[0];
				if (!guildProfile) return;

				if (!guildProfile.liveRoleID) return;
				const liverole = guildProfile.liveRoleID;

				if (!guildProfile.liveChannelID) return;
				const live = guildProfile.liveChannelID;
				newPresence.member.roles.remove(liverole).catch(() => {
					return client.channels.cache.get(live).send('An error occured removing the live role to the user! Please ensure **The Pack** bot role is higher than all users!').catch(console.error);
				});
				console.log(`${discName}, just stopped streaming.`);
				if (newPresence.member.voice.channel) {
					const voiceChannelID = newPresence.member.voice.channelId;
					await fetch(`https://discord.com/api/v10/channels/${voiceChannelID}/voice-status`, {
						method: 'POST',
						headers: {
							Authorization: `Bot ${process.env.TOKEN}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							status: '',
						}),
					});
				}
			}
		} catch (error) {
			return console.error(error);
		}
	});
};