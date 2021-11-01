const guildModel = require('../../models/guildSchema');

module.exports = client => {
	client.on('presenceUpdate', async (oldPresence, newPresence) => {
		const Guild = await newPresence.guild.fetch().catch(e => {
			return console.log(e);
		});

		const guildProfile = await guildModel.findOne({ guildId: Guild.id });
		if (!guildProfile) return;

		if (!guildProfile.liveRoleID) return;
		const liverole = guildProfile.liveRoleID;

		if (!guildProfile.liveChannelID) return;
		const live = guildProfile.liveChannelID;

		if (oldPresence == undefined) {
			return;
		}
		const oldStreamingStatus = oldPresence.activities.find(activity => activity.type === 'STREAMING') ? true : false;
		const newStreamingStatus = newPresence.activities.find(activity => activity.type === 'STREAMING') ? true : false;
		const discName = newPresence.user.username;
		if (newStreamingStatus === true && oldStreamingStatus === false) {
			const streamURL = newPresence.activities.find(activity => activity.type === 'STREAMING').url;
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
	});
};