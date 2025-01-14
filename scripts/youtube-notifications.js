const db = require('../database/db.js');

module.exports = client => {
    let isChecking = false;

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

    async function fetch_latest_videos(channelId, maxResults = 15) {
        try {
            const response = await fetch(
                `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}` +
                `&order=date&type=video&maxResults=${maxResults}&key=${process.env.YOUTUBE_API_KEY}`
            );
            const data = await response.json();

            if (!response.ok) {
                console.error('YouTube API error:', data);
                return [];
            }

            if (data.items && data.items.length) {
                const videos = data.items.map(item => ({
                    videoId: item.id.videoId,
                    videoSnippet: item.snippet,
                    publishedAt: new Date(item.snippet.publishedAt)
                }));
                // Sort newest first
                videos.sort((a, b) => b.publishedAt - a.publishedAt);
                return videos;
            }
            return [];
        } catch (error) {
            console.error(`Error fetching videos for channel ${channelId}:`, error);
            return [];
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
            const channelsToCheck = await fetch_channels_to_check();
            const lastCheckedVideos = await fetch_all_last_checked_videos();

            // Build a map of { channelId => [{ lastCheckedVideo, guildId, initialized }, ...] }
            const lastCheckedMap = new Map();
            for (const { channelId, lastCheckedVideo, guildId, initialized } of lastCheckedVideos) {
                if (!lastCheckedMap.has(channelId)) {
                    lastCheckedMap.set(channelId, []);
                }
                lastCheckedMap.get(channelId).push({ lastCheckedVideo, guildId, initialized });
            }

            for (const { channelId } of channelsToCheck) {
                const latestVideos = await fetch_latest_videos(channelId);
                if (!latestVideos.length) continue;

                const lastCheckedDataArray = lastCheckedMap.get(channelId);
                if (!lastCheckedDataArray || !lastCheckedDataArray.length) continue;

                // Process each guild that tracks this channel
                for (const lastCheckedData of lastCheckedDataArray) {
                    const { lastCheckedVideo, guildId, initialized } = lastCheckedData;

                    // If channel is not yet initialized, set the newest as lastChecked and skip notifications this round
                    if (!initialized) {
                        const mostRecentVideo = latestVideos[0];
                        if (mostRecentVideo) {
                            await update_last_checked_video(channelId, guildId, mostRecentVideo.videoId, true);
                            console.log(`Initialized channel ${channelId} for guild ${guildId} with video ${mostRecentVideo.videoId}`);
                        }
                        continue;
                    }

                    let newVideos = [];

                    // 2) Improved logic to avoid spamming if lastCheckedVideo is not in the most recent results
                    if (!lastCheckedVideo) {
                        // If there's no lastCheckedVideo at all, treat none as new for now,
                        // or you could treat them all as new. Depending on your preference:
                        // newVideos = [...latestVideos];

                        // Let's skip spamming the channel by setting the newest as last checked:
                        if (latestVideos[0]) {
                            await update_last_checked_video(channelId, guildId, latestVideos[0].videoId);
                        }
                        continue;
                    } else {
                        const index = latestVideos.findIndex(v => v.videoId === lastCheckedVideo);
                        if (index === -1) {
                            // fallback: if lastCheckedVideo isn't found among the fetched list,
                            // set the newest as "last checked" to prevent spamming
                            console.log(
                                `Could not find lastCheckedVideo (${lastCheckedVideo}) for channel ${channelId} in top ${latestVideos.length}.` +
                                ` Setting newest as last checked for guild ${guildId}.`
                            );
                            await update_last_checked_video(channelId, guildId, latestVideos[0].videoId);
                            newVideos = [];
                        } else {
                            // everything from 0..(index-1) is new
                            newVideos = latestVideos.slice(0, index);
                        }
                    }

                    // If we actually found new videos (published after the lastCheckedVideo),
                    // we need to notify in chronological order (oldest first).
                    if (!newVideos.length) {
                        console.log(`No new videos for channel ${channelId} in guild ${guildId}`);
                        continue;
                    }

                    // Reverse so the oldest new video is sent first
                    newVideos.reverse();

                    // Send notifications in sequence
                    const notificationPromises = newVideos.map(async ({ videoId, videoSnippet }) => {
                        try {
                            await send_notification(guildId, videoId, videoSnippet);
                            await update_last_checked_video(channelId, guildId, videoId);
                        } catch (error) {
                            console.error(`Failed to send notification for video ${videoId}:`, error);
                        }
                    });

                    await Promise.allSettled(notificationPromises);
                }
            }
        } catch (error) {
            if (error.message && error.message.includes('quota')) {
                console.error('YouTube API quota exceeded, retrying after some time...');
                // Retry after an hour
                setTimeout(checkChannels, 60 * 60 * 1000);
                nextCheckScheduled = true;
                return;
            } else {
                console.error('Error in checkChannels:', error);
            }
        } finally {
            isChecking = false;
            // Schedule the next check in 30 minutes if not already scheduled
            if (!nextCheckScheduled) {
                setTimeout(checkChannels, 30 * 60 * 1000);
            }
        }
    }

    checkChannels();
};
