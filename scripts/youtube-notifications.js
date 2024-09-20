const db = require('../database/db.js');
const fetch = require('node-fetch');

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

    async function fetch_latest_videos(channelId, maxResults = 5) {
        try {
            const response = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&order=date&type=video&maxResults=${maxResults}&key=${process.env.YOUTUBE_API_KEY}`);
            const data = await response.json();
            if (!response.ok) {
                console.error('YouTube API error:', data);
                return [];
            }
            if (data.items && data.items.length) {
                return data.items.map(item => ({
                    videoId: item.id.videoId,
                    videoSnippet: item.snippet,
                    publishedAt: new Date(item.snippet.publishedAt)
                }));
            }
            return [];
        } catch (error) {
            console.error(`Error fetching videos for channel ${channelId}:`, error);
            return [];
        }
    }

    async function fetch_last_checked_videos(channelId) {
        try {
            const [rows] = await db.pool.query('SELECT lastCheckedVideo, lastChecked, guildId FROM Youtube WHERE channelId = ?', [channelId]);
            return rows;
        } catch (error) {
            console.error('Error fetching last checked videos from database:', error);
            throw error;
        }
    }

    async function update_last_checked_video(channelId, guildId, videoId) {
        try {
            await db.pool.query('UPDATE Youtube SET lastCheckedVideo = ?, lastChecked = NOW() WHERE channelId = ? AND guildId = ?', [videoId, channelId, guildId]);
        } catch (error) {
            console.error('Error updating last checked video in database:', error);
            throw error;
        }
    }

    async function send_notification(guildId, videoId, videoSnippet) {
        try {
            const [guildRows] = await db.pool.query('SELECT youtubeChannelID FROM Guilds WHERE guildId = ?', [guildId]);
            if (guildRows.length > 0 && guildRows[0].youtubeChannelID) {
                const channel = await client.channels.fetch(guildRows[0].youtubeChannelID);
                if (channel) {
                    const message = `**${videoSnippet.channelTitle}** uploaded a new YouTube video!\nhttps://www.youtube.com/watch?v=${videoId} ||@everyone||`;
                    await channel.send(message);
                } else {
                    console.error(`Channel with ID ${guildRows[0].youtubeChannelID} not found`);
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
                const latestVideos = await fetch_latest_videos(channelId);
                if (!latestVideos.length) continue;

                const lastCheckedDataArray = await fetch_last_checked_videos(channelId);
                if (!lastCheckedDataArray.length) continue;

                for (const lastCheckedData of lastCheckedDataArray) {
                    const { lastCheckedVideo, guildId } = lastCheckedData;

                    // Find new videos that haven't been notified yet
                    const newVideos = [];
                    for (const videoData of latestVideos) {
                        if (videoData.videoId === lastCheckedVideo) {
                            // Reached the last notified video
                            break;
                        }
                        newVideos.push(videoData);
                    }

                    if (!newVideos.length) {
                        console.log(`No new videos for channel ${channelId} in guild ${guildId}`);
                        continue;
                    }

                    // Send notifications for new videos (from oldest to newest)
                    for (let i = newVideos.length - 1; i >= 0; i--) {
                        const { videoId, videoSnippet } = newVideos[i];
                        await send_notification(guildId, videoId, videoSnippet);
                        // Update the last checked video
                        await update_last_checked_video(channelId, guildId, videoId);
                    }
                }
            }
        } catch (error) {
            if (error.message.includes('quota')) {
                console.error('Quota exceeded, retrying after some time...');
                // Implement a retry mechanism, e.g., exponential backoff
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
        setInterval(() => {
            checkChannels();
        }, 1800000); // 30 minutes
    }

    checkChannelsInterval();
};