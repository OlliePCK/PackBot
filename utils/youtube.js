const { request } = require('undici');
const logger = require('../logger').child('youtube');

async function fetchYouTubeChannel(handle) {
    if (!handle) return null;
    const cleanHandle = handle.replace(/^@/, '').trim();
    if (!cleanHandle) return null;

    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
        logger.warn('YOUTUBE_API_KEY is not configured');
        return null;
    }

    try {
        // Try handle lookup first
        const res = await request(
            `https://www.googleapis.com/youtube/v3/channels?` +
            `part=snippet,statistics&forHandle=@${cleanHandle}&key=${apiKey}`
        );
        const body = await res.body.json();
        if (body.items && body.items.length) {
            const { snippet, statistics, id } = body.items[0];
            return { snippet, statistics, id };
        }

        // Fallback to username lookup
        const res2 = await request(
            `https://www.googleapis.com/youtube/v3/channels?` +
            `part=snippet,statistics&forUsername=${cleanHandle}&key=${apiKey}`
        );
        const body2 = await res2.body.json();
        if (!body2.items || !body2.items.length) return null;
        const { snippet, statistics, id } = body2.items[0];
        return { snippet, statistics, id };
    } catch (e) {
        logger.error('YouTube API error: ' + (e.stack || e));
        return null;
    }
}

module.exports = {
    fetchYouTubeChannel,
};
