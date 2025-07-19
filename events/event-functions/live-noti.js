// events/live-streaming.js
const db = require('../../database/db.js');
const { EmbedBuilder, ChannelType } = require('discord.js');

module.exports = client => {
	// In‑memory caches
	const guildProfiles = new Map();     // guildId → { liveRoleID, liveChannelID, generalChannelID, … }
	const isStreaming = new Map();     // userId → boolean
	const userVoiceCh = new Map();     // userId → voiceChannelId when they started streaming

	// Load or return cached guild profile
	async function getGuildProfile(guildId) {
		if (guildProfiles.has(guildId)) return guildProfiles.get(guildId);
		const [rows] = await db.pool.query(
			'SELECT liveRoleID, liveChannelID, generalChannelID FROM Guilds WHERE guildId = ?',
			[guildId]
		);
		const prof = rows[0] || {};
		guildProfiles.set(guildId, prof);
		return prof;
	}

	// ---------- PRESENCE UPDATE ----------
	client.on('presenceUpdate', async (oldP, newP) => {
		if (!oldP?.guild || !newP?.guild) return;
		if (oldP.userId !== newP.userId) return; // should never happen, but safe

		// Did they start/stop streaming?
		const wasStreaming = isStreaming.get(newP.userId) || false;
		const nowStreaming = newP.activities.some(a => a.type === 1);

		if (wasStreaming === nowStreaming) return; // no change

		const guildId = newP.guild.id;
		const prof = await getGuildProfile(guildId);
		if (!prof.liveRoleID || !prof.liveChannelID) {
			isStreaming.set(newP.userId, nowStreaming);
			return;
		}

		const roleId = prof.liveRoleID;
		const textChan = client.channels.cache.get(prof.liveChannelID);
		const member = newP.member;
		const name = newP.user.tag;

		// Build embed
		const embed = new EmbedBuilder()
			.setColor('#ff006a')
			.setFooter({ text: 'The Pack', iconURL: client.logo });

		if (nowStreaming) {
			// START STREAM
			isStreaming.set(newP.userId, true);
			const activity = newP.activities.find(a => a.type === 1);
			// Give role
			await member.roles.add(roleId).catch(() =>
				textChan?.send('❌ Couldn’t assign live role—check role hierarchy.')
			);
			// Announce
			embed
				.setTitle(`🔴 ${name} is now live!`)
				.setURL(activity.url)
				.setDescription(`Watch here: ${activity.url}`);
			textChan?.send({ embeds: [embed] }).catch(console.error);

			// If they’re in voice, remember that channel and set status
			const vc = member.voice.channel;
			if (vc) {
				userVoiceCh.set(newP.userId, vc.id);
				return setVoiceChannelStatus(vc, 'LIVE STREAMING 🔴');
			}
		} else {
			// STOP STREAM
			isStreaming.set(newP.userId, false);
			// Remove role
			await member.roles.remove(roleId).catch(() =>
				textChan?.send('❌ Couldn’t remove live role—check role hierarchy.')
			);
			// No announcement on stop—feel free to add one if you like

			// Clear voice channel status if we had set one
			const oldVcId = userVoiceCh.get(newP.userId);
			if (oldVcId) {
				const oldVc = client.channels.cache.get(oldVcId);
				userVoiceCh.delete(newP.userId);
				return setVoiceChannelStatus(oldVc, null);
			}
		}
	});

	// ---------- VOICE STATE UPDATE ----------
	client.on('voiceStateUpdate', async (oldS, newS) => {
		// Only care if they’re streaming AND their channel actually changed
		const userId = newS.member?.user?.id;
		if (!userId || !isStreaming.get(userId)) return;
		if (oldS.channelId === newS.channelId) return;

		// Get guild profile (we only need generalChannelID if you want notifications here)
		const prof = await getGuildProfile(newS.guild.id);
		// Clear old channel
		if (oldS.channelId) await setVoiceChannelStatus(client.channels.cache.get(oldS.channelId), null);
		// Set new channel
		if (newS.channelId) await setVoiceChannelStatus(client.channels.cache.get(newS.channelId), 'LIVE STREAMING 🔴');
	});

	// ---------- Helper: rename channel topic / name ----------
	async function setVoiceChannelStatus(channel, statusText) {
		if (!channel || channel.type !== ChannelType.GuildVoice) return;
		try {
			// Option A: change the channel’s topic (if you’re using a voice+text hybrid)
			if (channel.setTopic) {
				await channel.setTopic(statusText || '');
			}
			// Option B: rename the voice channel itself (be cautious of permission & rate limits!)
			else {
				await channel.edit({ name: statusText ? `${channel.name} 🔴 LIVE` : channel.name.replace(/ 🔴 LIVE$/, '') });
			}
		} catch (err) {
			console.error(`Failed updating voice channel ${channel.id}:`, err);
		}
	}
};
