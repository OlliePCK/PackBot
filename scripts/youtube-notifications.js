const db = require('../database/db.js');
const { request } = require('undici');

module.exports = client => {
    let isChecking = false;

    async function fetch_channels_to_check() {
        try {
            const [rows] = await db.pool.query('SELECT DISTINCT channelId FROM Youtube');
            return rows;
        } catch (error) {
            console.error('Error fetching channels from database:', error);
            throw error;
        }
    }

    async function fetch_latest_video(channelId) {
        try {
            const response = await request(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&order=date&maxResults=1&key=${process.env.YOUTUBE_API_KEY}`);
            const video = await response.body.json();
            if (response.statusCode !== 200) {
                console.error('YouTube API error:', video);
                return null;
            }
            if (video.items && video.items.length) {
                return {
                    videoId: video.items[0].id.videoId,
                    videoSnippet: video.items[0].snippet,
                    publishedAt: new Date(video.items[0].snippet.publishedAt)
                };
            }
            return null;
        } catch (error) {
            console.error(`Error fetching video for channel ${channelId}:`, error);
            return null;
        }
    }

    async function fetch_last_checked_video(channelId) {
        try {
            const [rows] = await db.pool.query('SELECT lastCheckedVideo, lastChecked, guildId FROM Youtube WHERE channelId = ?', [channelId]);
            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            console.error('Error fetching last checked video from database:', error);
            throw error;
        }
    }

    async function update_last_checked_video(channelId, videoId) {
        try {
            await db.pool.query('UPDATE Youtube SET lastCheckedVideo = ?, lastChecked = NOW() WHERE channelId = ?', [videoId, channelId]);
        } catch (error) {
            console.error('Error updating last checked video in database:', error);
            throw error;
        }
    }

    async function send_notification(guildId, videoId, videoSnippet) {
        try {
            const [guild] = await db.pool.query('SELECT youtubeChannelID FROM Guilds WHERE guildId = ?', [guildId]);
            if (guild.length > 0 && guild[0].youtubeChannelID) {
                const channel = await client.channels.fetch(guild[0].youtubeChannelID);
                if (channel) {
                    const message = `**${videoSnippet.channelTitle}** uploaded a new YouTube video!\nhttps://www.youtube.com/watch?v=${videoId} ||@everyone||`;
                    await channel.send(message);
                } else {
                    console.error(`Channel with ID ${guild[0].youtubeChannelID} not found`);
                }
            }
        } catch (error) {
            console.error('Error sending notification:', error);
            throw error;
        }
    }

    async function checkChannels() {
        if (isChecking) return;
        isChecking = true;

        try {
            const channels = await fetch_channels_to_check();
            for (const { channelId } of channels) {
                const latestVideoData = await fetch_latest_video(channelId);
                if (!latestVideoData) continue;

                const { videoId, videoSnippet, publishedAt } = latestVideoData;

                const lastCheckedData = await fetch_last_checked_video(channelId);
                if (lastCheckedData) {
                    const lastCheckedAt = new Date(lastCheckedData.lastChecked);
                    if (publishedAt <= lastCheckedAt) {
                        console.log(`Skipping older video for channel ${channelId}`);
                        continue;
                    }
                }

                // New video found, send notification
                await send_notification(lastCheckedData.guildId, videoId, videoSnippet);
                // Update the database with the new video ID
                await update_last_checked_video(channelId, videoId);
            }
        } catch (error) {
            if (error.message.includes('quota')) {
                console.error('Quota exceeded, retrying after some time...');
                // Implement a retry mechanism, e.g., backoff strategy
                setTimeout(checkChannels, 60 * 60 * 1000); // Retry after 1 hour
            } else {
                console.error('Error in checkChannels:', error);
            }
        } finally {
            isChecking = false;
        }
    }

    function checkChannelsInterval() {
        checkChannels();
        setInterval(checkChannels, 1800000); // 30 minutes
    }

    checkChannelsInterval();
};