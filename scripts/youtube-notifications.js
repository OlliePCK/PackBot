// scripts/youtube-notifications.js
const db = require('../database/db.js');
const axios = require('axios');
const pLimit = require('p-limit').default;
const cron = require('node-cron');
const { EmbedBuilder } = require('discord.js');
const { HttpsProxyAgent } = require('https-proxy-agent');

module.exports = client => {
    const CONCURRENCY = 5;
    const limit = pLimit(CONCURRENCY);

    // 1) Load all channels & guilds to notify, plus their Discord channel IDs
    async function loadWatchList() {
        const [rows] = await db.pool.query(`
      SELECT y.channelId,
             y.guildId,
             y.lastCheckedVideo,
             y.initialized,
             g.youtubeChannelID AS notifyChannel
        FROM Youtube y
        JOIN Guilds  g ON g.guildId = y.guildId
       WHERE g.youtubeChannelID IS NOT NULL
    `);
        // group by channelId
        return rows.reduce((map, row) => {
            (map[row.channelId] ||= []).push(row);
            return map;
        }, {});
    }

    // 2) Fetch latest videos for a channel
    async function fetchLatestVideos(channelId, maxResults = 15) {
        const proxyUrl = process.env.PROXY_URL;
        const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
        const url = `https://www.googleapis.com/youtube/v3/search`
            + `?part=snippet&channelId=${channelId}`
            + `&order=date&type=video&maxResults=${maxResults}`
            + `&key=${process.env.YOUTUBE_API_KEY}`;

        const res = await axios.get(url, { httpsAgent: agent });
        if (!Array.isArray(res.data.items)) return [];

        return res.data.items
            .map(item => ({
                videoId: item.id.videoId,
                snippet: item.snippet,
                publishedAt: new Date(item.snippet.publishedAt),
            }))
            .sort((a, b) => b.publishedAt - a.publishedAt);
    }

    // 3) Send notification embed to a Discord channel
    async function sendNotification(client, notifyChannelId, video) {
        const channel = await client.channels.fetch(notifyChannelId).catch(() => null);
        if (!channel?.isTextBased()) return;

        const embed = new EmbedBuilder()
            .setTitle(video.snippet.title)
            .setURL(`https://www.youtube.com/watch?v=${video.videoId}`)
            .setThumbnail(video.snippet.thumbnails.high.url)
            .setDescription(`**${video.snippet.channelTitle}** uploaded a new video!`)
            .setColor('#ff006a')
            .setFooter({ text: 'The Pack', iconURL: client.logo });

        await channel.send({ content: `🔔 New video: https://www.youtube.com/watch?v=${video.videoId}`, embeds: [embed] });
    }

    // 4) For each group of guilds tracking the same channel, notify & prepare DB updates
    async function notifyAndCollectUpdates(client, channelId, group, latest) {
        const updates = [];
        for (const { guildId, lastCheckedVideo, initialized, notifyChannel } of group) {
            // If not initialized, seed and skip notifications
            if (!initialized) {
                updates.push([channelId, guildId, latest[0].videoId, 1]);
                continue;
            }
            // If no lastCheckedVideo, seed it
            if (!lastCheckedVideo) {
                updates.push([channelId, guildId, latest[0].videoId, 1]);
                continue;
            }
            // Find index of stored video
            const idx = latest.findIndex(v => v.videoId === lastCheckedVideo);
            if (idx <= 0) continue; // no new videos
            const newVideos = latest.slice(0, idx).reverse(); // oldest first

            for (const video of newVideos) {
                try {
                    await sendNotification(client, notifyChannel, video);
                } catch (err) {
                    console.error(`Failed to notify guild ${guildId}:`, err);
                }
                updates.push([channelId, guildId, video.videoId, 1]);
            }
        }
        return updates;
    }

    // 5) Main check loop
    async function checkChannels() {
        console.log('🔍 Starting YouTube channel check...');
        const watchList = await loadWatchList();
        const tasks = Object.entries(watchList).map(([channelId, group]) =>
            limit(async () => {
                try {
                    const latest = await fetchLatestVideos(channelId);
                    if (latest.length === 0) return [];
                    return await notifyAndCollectUpdates(client, channelId, group, latest);
                } catch (err) {
                    console.error(`Error processing channel ${channelId}:`, err);
                    return [];
                }
            })
        );

        const results = await Promise.all(tasks);
        // flatten and batch‑write updates
        const updates = results.flat();
        if (updates.length) {
            await db.pool.query(`
        INSERT INTO Youtube
          (channelId, guildId, lastCheckedVideo, initialized, lastChecked)
        VALUES ?
        ON DUPLICATE KEY UPDATE
          lastCheckedVideo = VALUES(lastCheckedVideo),
          initialized       = VALUES(initialized),
          lastChecked       = VALUES(lastChecked)
      `, [updates]);
            console.log(`✅ Applied ${updates.length} update(s) to DB.`);
        } else {
            console.log('✅ No new videos found.');
        }
    }

    // 6) Schedule every 30 minutes on the dot
    cron.schedule('*/30 * * * *', () => {
        checkChannels().catch(err => console.error('YouTube notifier error:', err));
    });

    console.log('🗓️ Scheduled YouTube notifications every 30 minutes.');
};
