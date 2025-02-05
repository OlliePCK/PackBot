const db = require('../database/db.js');

module.exports = client => {
    let isChecking = false;

    const axios = require('axios');
    const { HttpsProxyAgent } = require('https-proxy-agent');

    async function fetch_latest_videos(channelId, maxResults = 15) {
        try {
            const proxyUrl = process.env.PROXY_URL; // Make sure it's properly encoded!
            const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

            const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}` +
                `&order=date&type=video&maxResults=${maxResults}&key=${process.env.YOUTUBE_API_KEY}`;

            const response = await axios.get(url, { httpsAgent: agent });
            const data = response.data;

            if (data.items && data.items.length) {
                const videos = data.items.map(item => ({
                    videoId: item.id.videoId,
                    videoSnippet: item.snippet,
                    publishedAt: new Date(item.snippet.publishedAt)
                }));
                videos.sort((a, b) => b.publishedAt - a.publishedAt);
                return videos;
            }
            return [];
        } catch (error) {
            console.error(`Error fetching videos for channel ${channelId}:`, error);
            return [];
        }
    }

    // 1) Increase maxResults to 15 by default (instead of 5)
    async function fetch_channels_to_check() {
        try {
            const [rows] = await db.pool.query('SELECT DISTINCT channelId FROM Youtube');
            return rows;
        } catch (error) {
            console.error('Error fetching channels from database:', error);
            throw error;
        }
    }

    async function fetch_all_last_checked_videos() {
        try {
            const [rows] = await db.pool.query('SELECT channelId, lastCheckedVideo, guildId, initialized FROM Youtube');
            return rows;
        } catch (error) {
            console.error('Error fetching last checked videos from database:', error);
            throw error;
        }
    }

    async function update_last_checked_video(channelId, guildId, videoId, initialized = true) {
        try {
            // Log the update attempt
            console.log(`Updating lastCheckedVideo for channel ${channelId} (guild ${guildId}) to video ${videoId} (initialized: ${initialized})`);
            await db.pool.query(
                'UPDATE Youtube SET lastCheckedVideo = ?, lastChecked = NOW(), initialized = ? WHERE channelId = ? AND guildId = ?',
                [videoId, initialized, channelId, guildId]
            );
        } catch (error) {
            console.error('Error updating last checked video in database:', error);
            throw error;
        }
    }

    async function send_notification(guildId, videoId, videoSnippet) {
        try {
            const [guildRows] = await db.pool.query(
                'SELECT youtubeChannelID FROM Guilds WHERE guildId = ?',
                [guildId]
            );
            if (guildRows.length > 0 && guildRows[0].youtubeChannelID) {
                const channel = await client.channels.fetch(guildRows[0].youtubeChannelID);
                if (channel) {
                    const message = {
                        content: `**${videoSnippet.channelTitle}** uploaded a new video: **${videoSnippet.title}**\nhttps://www.youtube.com/watch?v=${videoId}`,
                        embeds: [{
                            title: videoSnippet.title,
                            url: `https://www.youtube.com/watch?v=${videoId}`,
                            thumbnail: {
                                url: videoSnippet.thumbnails.default.url,
                            },
                        }],
                    };
                    console.log(`Sending notification for video ${videoId} to guild ${guildId} (channel ${guildRows[0].youtubeChannelID})`);
                    await channel.send(message);
                } else {
                    console.error(`Channel with ID ${guildRows[0].youtubeChannelID} not found`);
                }
            }
        } catch (error) {
            console.error(`Error sending notification to guild ${guildId}:`, error);
        }
    }

    async function checkChannels() {
        if (isChecking) return;
        isChecking = true;

        let nextCheckScheduled = false;

        try {
            console.log('Starting channel check...');
            const channelsToCheck = await fetch_channels_to_check();
            console.log(`Found ${channelsToCheck.length} channel(s) to check.`);
            const lastCheckedVideos = await fetch_all_last_checked_videos();
            console.log(`Fetched ${lastCheckedVideos.length} lastChecked record(s) from DB.`);

            // Build a map: channelId => array of { lastCheckedVideo, guildId, initialized }
            const lastCheckedMap = new Map();
            for (const { channelId, lastCheckedVideo, guildId, initialized } of lastCheckedVideos) {
                if (!lastCheckedMap.has(channelId)) {
                    lastCheckedMap.set(channelId, []);
                }
                lastCheckedMap.get(channelId).push({ lastCheckedVideo, guildId, initialized });
            }

            for (const { channelId } of channelsToCheck) {
                console.log(`Processing channel: ${channelId}`);
                const latestVideos = await fetch_latest_videos(channelId);
                console.log(`Fetched ${latestVideos.length} video(s) for channel ${channelId}.`);

                if (!latestVideos.length) continue;

                // Log video IDs for debugging
                console.log(`Latest videos for channel ${channelId}: ${latestVideos.map(v => v.videoId).join(', ')}`);

                const lastCheckedDataArray = lastCheckedMap.get(channelId);
                if (!lastCheckedDataArray || !lastCheckedDataArray.length) {
                    console.warn(`No lastChecked data for channel ${channelId}. Skipping...`);
                    continue;
                }

                // Process each guild that tracks this channel
                for (const lastCheckedData of lastCheckedDataArray) {
                    const { lastCheckedVideo, guildId, initialized } = lastCheckedData;
                    console.log(`Guild ${guildId} tracking channel ${channelId} - lastCheckedVideo: ${lastCheckedVideo}, initialized: ${initialized}`);

                    // If not yet initialized, update with the most recent video and skip notifications
                    if (!initialized) {
                        const mostRecentVideo = latestVideos[0];
                        if (mostRecentVideo) {
                            console.log(`Initializing channel ${channelId} for guild ${guildId} with video ${mostRecentVideo.videoId}`);
                            await update_last_checked_video(channelId, guildId, mostRecentVideo.videoId, true);
                        }
                        continue;
                    }

                    let newVideos = [];
                    if (!lastCheckedVideo) {
                        console.log(`No lastCheckedVideo found for channel ${channelId} in guild ${guildId}. Setting newest video as lastChecked to avoid spamming.`);
                        if (latestVideos[0]) {
                            await update_last_checked_video(channelId, guildId, latestVideos[0].videoId);
                        }
                        continue;
                    } else {
                        const index = latestVideos.findIndex(v => v.videoId === lastCheckedVideo);
                        console.log(`Index of stored video (${lastCheckedVideo}) in fetched list for channel ${channelId}: ${index}`);
                        if (index === -1) {
                            console.log(`Stored video (${lastCheckedVideo}) not found among the top ${latestVideos.length} videos for channel ${channelId}. Updating to newest video for guild ${guildId}.`);
                            await update_last_checked_video(channelId, guildId, latestVideos[0].videoId);
                            newVideos = [];
                        } else {
                            // New videos are those before the stored video in the list
                            newVideos = latestVideos.slice(0, index);
                        }
                    }

                    if (!newVideos.length) {
                        console.log(`No new videos for channel ${channelId} in guild ${guildId}.`);
                        continue;
                    }

                    // Reverse to notify in chronological order (oldest first)
                    newVideos.reverse();
                    for (const { videoId, videoSnippet } of newVideos) {
                        try {
                            console.log(`Notifying guild ${guildId} of new video ${videoId}`);
                            await send_notification(guildId, videoId, videoSnippet);
                            await update_last_checked_video(channelId, guildId, videoId);
                        } catch (error) {
                            console.error(`Failed to notify for video ${videoId}:`, error);
                        }
                    }
                }
            }
        } catch (error) {
            if (error.message && error.message.includes('quota')) {
                console.error('YouTube API quota exceeded, retrying after 1 hour...');
                setTimeout(checkChannels, 60 * 60 * 1000);
                nextCheckScheduled = true;
                return;
            } else {
                console.error('Error during channel check:', error);
            }
        } finally {
            isChecking = false;
            if (!nextCheckScheduled) {
                console.log('Scheduling next channel check in 30 minutes.');
                setTimeout(checkChannels, 30 * 60 * 1000);
            }
        }
    }

    checkChannels();
};
