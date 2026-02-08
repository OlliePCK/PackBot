const { EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const logger = require('../logger').child('polls');

const BAR_LENGTH = 10;

module.exports = function pollExpiry(client) {
    // Check for expired polls every 30 seconds
    setInterval(async () => {
        try {
            const [expired] = await db.pool.query(
                'SELECT * FROM Polls WHERE closed = 0 AND expiresAt <= NOW()'
            );

            for (const poll of expired) {
                await db.pool.query('UPDATE Polls SET closed = 1 WHERE id = ?', [poll.id]);

                try {
                    const guild = client.guilds.cache.get(poll.guildId);
                    if (!guild) continue;
                    const channel = guild.channels.cache.get(poll.channelId);
                    if (!channel) continue;
                    const message = await channel.messages.fetch(poll.messageId).catch(() => null);
                    if (!message) continue;

                    const options = JSON.parse(poll.options);
                    const votes = JSON.parse(poll.votes);
                    const totalVotes = Object.values(votes).reduce((sum, arr) => sum + arr.length, 0);

                    const results = options.map((opt, i) => {
                        const count = (votes[String(i)] || []).length;
                        const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                        const filled = totalVotes > 0 ? Math.round((count / totalVotes) * BAR_LENGTH) : 0;
                        const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(BAR_LENGTH - filled);
                        return `**${i + 1}.** ${opt}\n${bar} ${count} vote${count !== 1 ? 's' : ''} (${pct}%)`;
                    }).join('\n\n');

                    const embed = new EmbedBuilder()
                        .setTitle('Poll Results')
                        .setDescription(`**${poll.question}**\n\n${results}`)
                        .setColor('#00ff00')
                        .setTimestamp();

                    // Find winner(s)
                    let maxVotes = 0;
                    options.forEach((_, i) => {
                        const count = (votes[String(i)] || []).length;
                        if (count > maxVotes) maxVotes = count;
                    });
                    if (maxVotes > 0) {
                        const winners = options.filter((_, i) => (votes[String(i)] || []).length === maxVotes);
                        embed.addFields({ name: 'Winner', value: winners.join(', '), inline: true });
                    }
                    embed.addFields({ name: 'Total Votes', value: `${totalVotes}`, inline: true });
                    embed.setFooter({ text: 'Poll closed' });

                    await message.edit({ embeds: [embed], components: [] });
                } catch (e) {
                    // Message may have been deleted
                }
            }
        } catch (e) {
            logger.error('Poll expiry check error', { error: e.message });
        }
    }, 30000);

    logger.info('Poll expiry checker initialized');
};
