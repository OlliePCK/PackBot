const { general } = require('../../config.json');

module.exports = client => {
	client.on('presenceUpdate', async (oldPresence, newPresence) => {
		if (newPresence == undefined || oldPresence == undefined) {
			return;
		}
		else {
			const oldAct = oldPresence.activities.find(activity => activity.timestamps != null);
			if (oldAct) {
				const newAct = newPresence.activities.find(activity => activity.name == oldAct.name);
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
			}
			else {return;}
		}
	});
};