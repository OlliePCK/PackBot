const guildModel = require('../../models/guildSchema');

module.exports = client => {
	client.on('presenceUpdate', async (oldPresence, newPresence) => {
		const Guild = newPresence.guild;

		if (Guild == undefined | Guild == null) {
			return;
		}

		const guildProfile = await guildModel.findOne({ guildId: Guild.id });
		if (!guildProfile) return;

		if (!guildProfile.generalChannelID) return;
		const general = guildProfile.generalChannelID;

		if (newPresence == undefined || oldPresence == undefined) {
			return;
		}
		const oldAct = oldPresence.activities.find(activity => activity.timestamps != null);
		if (oldAct) {
			const newAct = newPresence.activities.find(activity => activity.name == oldAct.name);
			if (newPresence.user.id == '99845226209742848') {
				return;
			}
			if (oldAct.name == '@everyone' || oldAct.name == '@here') {
				return;
			}
			if (newAct == undefined) {
				const n = new Date();
				const g = oldAct.timestamps.start;
				if (g <= 0) {
					return;
				}
				const hours = Math.abs(n - g) / 36e5;
				if (hours >= 6) {
					console.log(`${oldPresence.user.username} has been playing ${oldAct.name} for ${Math.round(hours)} hours.`);
					return client.channels.cache.get(general).send(`${oldPresence.user.username} has been playing ${oldAct.name} for ${Math.round((hours) * 100) / 100} hours.`);
				}
			}
			else {return;}
		}
	});
};