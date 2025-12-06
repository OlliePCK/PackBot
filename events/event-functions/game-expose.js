// events/game-expose.js - Track playtime and notify for long sessions
const db = require('../../database/db.js');
const logger = require('../../logger').child('playtime');
const { ChannelType } = require('discord.js');

module.exports = client => {
    // In-memory cache of guild -> generalChannelID
    const guildChannels = new Map();

    // Helper to load & cache a guild's channel
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

    // Track when someone started an activity with timestamps
    const startTimes = new Map(); // key = odUserId|activityName, value = { start, guildId, odUsername }

    // Save playtime to database
    async function recordPlaytime(guildId, odUserId, odUsername, gameName, seconds) {
        try {
            await db.pool.query(`
                INSERT INTO Playtime (guildId, odUserId, odUsername, gameName, totalSeconds)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                    totalSeconds = totalSeconds + VALUES(totalSeconds),
                    odUsername = VALUES(odUsername),
                    lastPlayed = CURRENT_TIMESTAMP
            `, [guildId, odUserId, odUsername, gameName, Math.floor(seconds)]);
        } catch (e) {
            // Table might not exist yet - that's okay
            if (e.code !== 'ER_NO_SUCH_TABLE') {
                logger.error('Playtime record error: ' + (e.stack || e));
            }
        }
    }

    client.on('presenceUpdate', (oldP, newP) => {
        // 1) Must have both presences and a guild
        if (!oldP?.guild || !newP?.guild) return;

        // 2) Get activities with timestamps from both old and new presence
        const oldActivities = oldP.activities.filter(a => a.timestamps?.start);
        const newActivities = newP.activities.filter(a => a.timestamps?.start);
        
        // 3) Check for newly started activities
        for (const newAct of newActivities) {
            const key = `${newP.userId}|${newAct.name}`;
            // If we're not already tracking this activity, start tracking
            if (!startTimes.has(key)) {
                startTimes.set(key, {
                    start: newAct.timestamps.start,
                    guildId: newP.guild.id,
                    odUsername: newP.user?.tag || newP.user?.username || 'Unknown'
                });
            }
        }
        
        // 4) Check for stopped activities
        for (const oldAct of oldActivities) {
            const key = `${newP.userId}|${oldAct.name}`;
            const stillPlaying = newActivities.some(a => a.name === oldAct.name);
            
            if (!stillPlaying) {
                const tracking = startTimes.get(key);
                startTimes.delete(key);
                
                if (!tracking) continue;

                const seconds = (Date.now() - tracking.start) / 1000;
                const hours = seconds / 3600;
                
                // Record all playtime to database (minimum 1 minute to avoid spam)
                if (seconds >= 60) {
                    recordPlaytime(
                        tracking.guildId,
                        newP.userId,
                        newP.user?.tag || newP.user?.username || 'Unknown',
                        oldAct.name,
                        seconds
                    );
                }

                // Only announce if 6+ hours
                if (hours < 6) continue;

                // 5) Lookup the general channel once & send
                getGeneralChannel(newP.guild.id).then(chId => {
                    if (!chId) return;
                    const chan = client.channels.cache.get(chId);
                    if (chan && (chan.type === ChannelType.GuildText || chan.type === ChannelType.GuildAnnouncement)) {
                        chan.send(
                            `${newP.user?.tag || 'Someone'} played **${oldAct.name}** for ${hours.toFixed(2)} hours!`
                        ).catch(e => logger.error('Game-expose send error: ' + (e.stack || e)));
                    }
                }).catch(e => logger.error('Game-expose fetch error: ' + (e.stack || e)));
            }
        }
    });
    
    logger.info('Game-expose event function initialized');
};
