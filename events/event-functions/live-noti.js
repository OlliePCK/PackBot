const db = require('../../database/db.js');
module.exports = client => {
	// Handle presence updates (detect streaming start/stop)
	client.on('presenceUpdate', async (oldPresence, newPresence) => {
		const Guild = newPresence.guild;
		if (!Guild) return;

		try {
			if (!oldPresence) return;

			const oldStreamingStatus = !!oldPresence.activities.find(activity => activity.type === 1);
			const newStreamingStatus = !!newPresence.activities.find(activity => activity.type === 1);
			const discName = newPresence.user.username;

			if (oldStreamingStatus === newStreamingStatus) return;

			// Fetch guild profile only once
			const [rows] = await db.pool.query('SELECT * FROM Guilds WHERE guildId = ?', [Guild.id]);
			const guildProfile = rows[0];
			if (!guildProfile || !guildProfile.liveRoleID || !guildProfile.liveChannelID) return;

			const liverole = guildProfile.liveRoleID;
			const liveChannel = client.channels.cache.get(guildProfile.liveChannelID);

			if (newStreamingStatus && !oldStreamingStatus) {
				const streamURL = newPresence.activities.find(activity => activity.type === 1).url;
				console.log(`${discName}, just went live!`);

				// Add live role and notify channel
				await newPresence.member.roles.add(liverole).catch(() => {
					return liveChannel.send('An error occurred adding the live role to the user! Please ensure **The Pack** bot role is higher than all users!').catch(console.error);
				});
				liveChannel.send(`**${discName}** just went live! Watch: ${streamURL}`).catch(console.error);

				// Update voice channel status if in a voice channel
				if (newPresence.member.voice.channel) {
					const voiceChannelID = newPresence.member.voice.channelId;
					await updateVoiceChannelStatus(voiceChannelID, 'LIVE STREAMING 🔴');
				}
			} else if (!newStreamingStatus && oldStreamingStatus) {
				console.log(`${discName}, just stopped streaming.`);

				// Remove live role and notify channel
				await newPresence.member.roles.remove(liverole).catch(() => {
					return liveChannel.send('An error occurred removing the live role from the user! Please ensure **The Pack** bot role is higher than all users!').catch(console.error);
				});

				// Clear voice channel status if in a voice channel
				if (newPresence.member.voice.channel) {
					const voiceChannelID = newPresence.member.voice.channelId;
					await updateVoiceChannelStatus(voiceChannelID, '');
				}
			}
		} catch (error) {
			console.error(error);
		}
	});

	// Handle user switching or leaving voice channels
	client.on('voiceStateUpdate', async (oldState, newState) => {
		const Guild = newState.guild;
		if (!Guild) return;

		const user = newState.member.user;
		const discName = user.username;

		// Fetch the current presence of the user
		const newPresence = newState.member.presence;
		if (!newPresence) return;

		// Check if the user is streaming
		const streamingStatus = !!newPresence.activities.find(activity => activity.type === 1);

		if (!streamingStatus) return;

		// Fetch guild profile
		const [rows] = await db.pool.query('SELECT * FROM Guilds WHERE guildId = ?', [Guild.id]);
		const guildProfile = rows[0];
		if (!guildProfile || !guildProfile.liveRoleID || !guildProfile.liveChannelID) return;

		if (oldState.channelId && !newState.channelId) {
			// User left the voice channel while streaming
			console.log(`${discName} left the voice channel while streaming.`);
			await updateVoiceChannelStatus(oldState.channelId, '');  // Clear the old channel's status
		} else if (oldState.channelId !== newState.channelId && newState.channelId) {
			// User switched channels while streaming
			console.log(`${discName} switched voice channels while streaming.`);
			if (oldState.channelId) await updateVoiceChannelStatus(oldState.channelId, '');  // Clear the old channel's status
			await updateVoiceChannelStatus(newState.channelId, 'LIVE STREAMING 🔴');  // Set the new channel's status
		}
	});

	// Helper function to update the voice channel status
	async function updateVoiceChannelStatus(channelId, status) {
		try {
			await fetch(`https://discord.com/api/v10/channels/${channelId}/voice-status`, {
				method: 'PUT',
				headers: {
					Authorization: `Bot ${process.env.TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ status }),
			});
		} catch (error) {
			console.error(`Failed to update status for channel ${channelId}:`, error);
		}
	}
};
