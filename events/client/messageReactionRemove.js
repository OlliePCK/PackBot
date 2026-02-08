const db = require('../../database/db');
const { getGuildProfile } = require('../../utils/guildSettingsCache');
const logger = require('../../logger').child('starboard');

module.exports = {
    name: 'messageReactionRemove',
    async execute(reaction, user) {
        if (!reaction.message.guild) return;
        if (user.bot) return;
        if (reaction.emoji.name !== '\u2B50') return;

        if (reaction.partial) {
            try { await reaction.fetch(); } catch { return; }
        }

        const guildId = reaction.message.guild.id;
        const guildProfile = await getGuildProfile(guildId);

        if (!guildProfile.starboardChannelID) return;
        if (reaction.message.channel.id === guildProfile.starboardChannelID) return;

        const threshold = guildProfile.starThreshold || 3;
        const starCount = reaction.count;

        try {
            const [existing] = await db.pool.query(
                'SELECT * FROM Starboard WHERE guildId = ? AND originalMessageId = ?',
                [guildId, reaction.message.id]
            );

            if (existing.length === 0) return;

            if (starCount < threshold) {
                // Below threshold — remove starboard message and DB entry
                if (existing[0].starboardMessageId) {
                    try {
                        const starboardChannel = reaction.message.guild.channels.cache.get(guildProfile.starboardChannelID);
                        if (starboardChannel) {
                            const sbMsg = await starboardChannel.messages.fetch(existing[0].starboardMessageId);
                            await sbMsg.delete();
                        }
                    } catch { /* message already deleted */ }
                }
                await db.pool.query('DELETE FROM Starboard WHERE id = ?', [existing[0].id]);
            } else {
                // Still above threshold — just update count
                await db.pool.query('UPDATE Starboard SET starCount = ? WHERE id = ?', [starCount, existing[0].id]);

                if (existing[0].starboardMessageId) {
                    try {
                        const starboardChannel = reaction.message.guild.channels.cache.get(guildProfile.starboardChannelID);
                        if (starboardChannel) {
                            const sbMsg = await starboardChannel.messages.fetch(existing[0].starboardMessageId);
                            await sbMsg.edit({ content: `\u2B50 **${starCount}** | <#${reaction.message.channel.id}>` });
                        }
                    } catch { /* message already deleted */ }
                }
            }
        } catch (e) {
            logger.error('Starboard remove error', { error: e.message, guildId });
        }
    },
};
