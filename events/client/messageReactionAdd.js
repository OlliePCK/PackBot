const { EmbedBuilder } = require('discord.js');
const db = require('../../database/db');
const { getGuildProfile } = require('../../utils/guildSettingsCache');
const logger = require('../../logger').child('starboard');

module.exports = {
    name: 'messageReactionAdd',
    async execute(reaction, user) {
        if (!reaction.message.guild) return;
        if (user.bot) return;
        if (reaction.emoji.name !== '\u2B50') return;

        // Fetch partials if needed
        if (reaction.partial) {
            try { await reaction.fetch(); } catch { return; }
        }
        if (reaction.message.partial) {
            try { await reaction.message.fetch(); } catch { return; }
        }

        const guildId = reaction.message.guild.id;
        const guildProfile = await getGuildProfile(guildId);

        if (!guildProfile.starboardChannelID) return;
        const threshold = guildProfile.starThreshold || 3;
        const starCount = reaction.count;

        // Don't starboard messages in the starboard channel itself
        if (reaction.message.channel.id === guildProfile.starboardChannelID) return;

        if (starCount < threshold) return;

        const message = reaction.message;
        const starboardChannel = message.guild.channels.cache.get(guildProfile.starboardChannelID);
        if (!starboardChannel) return;

        try {
            const [existing] = await db.pool.query(
                'SELECT * FROM Starboard WHERE guildId = ? AND originalMessageId = ?',
                [guildId, message.id]
            );

            const embed = new EmbedBuilder()
                .setAuthor({ name: message.author.displayName || message.author.username, iconURL: message.author.displayAvatarURL() })
                .setDescription(message.content || '*No text content*')
                .addFields(
                    { name: 'Source', value: `[Jump to message](${message.url})`, inline: true },
                    { name: 'Channel', value: `<#${message.channel.id}>`, inline: true }
                )
                .setColor('#FFD700')
                .setTimestamp(message.createdAt)
                .setFooter({ text: `${starCount} \u2B50` });

            // Add first image attachment if present
            const imageAttachment = message.attachments.find(a => a.contentType?.startsWith('image/'));
            if (imageAttachment) embed.setImage(imageAttachment.url);

            if (existing.length > 0) {
                // Update existing starboard entry
                await db.pool.query(
                    'UPDATE Starboard SET starCount = ? WHERE id = ?',
                    [starCount, existing[0].id]
                );
                if (existing[0].starboardMessageId) {
                    try {
                        const sbMsg = await starboardChannel.messages.fetch(existing[0].starboardMessageId);
                        await sbMsg.edit({ content: `\u2B50 **${starCount}** | <#${message.channel.id}>`, embeds: [embed] });
                    } catch { /* starboard message may have been deleted */ }
                }
            } else {
                // Create new starboard entry
                const sbMsg = await starboardChannel.send({
                    content: `\u2B50 **${starCount}** | <#${message.channel.id}>`,
                    embeds: [embed]
                });
                await db.pool.query(
                    `INSERT INTO Starboard (guildId, originalMessageId, starboardMessageId, channelId, authorId, content, attachmentUrl, starCount)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [guildId, message.id, sbMsg.id, message.channel.id, message.author.id,
                     message.content?.substring(0, 2000) || null, imageAttachment?.url || null, starCount]
                );
            }
        } catch (e) {
            logger.error('Starboard error', { error: e.message, guildId, messageId: message.id });
        }
    },
};
