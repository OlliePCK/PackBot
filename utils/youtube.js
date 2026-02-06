const { request } = require('undici');
const logger = require('../logger').child('youtube');

function getYouTubeApiKey() {
    return process.env.YOUTUBE_API_KEY || null;
}

function parseIsoDurationToSeconds(iso) {
    if (!iso || typeof iso !== 'string') return null;
    const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return null;
    const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
    const minutes = match[2] ? Number.parseInt(match[2], 10) : 0;
    const seconds = match[3] ? Number.parseInt(match[3], 10) : 0;
    return (hours * 3600) + (minutes * 60) + seconds;
}

function extractYouTubeVideoId(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
        if (host === 'youtu.be') {
            const id = parsed.pathname.split('/').filter(Boolean)[0];
            return id || null;
        }
        if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com') || host.endsWith('music.youtube.com')) {
            const vParam = parsed.searchParams.get('v');
            if (vParam) return vParam;
            const parts = parsed.pathname.split('/').filter(Boolean);
            const idx = parts.findIndex(p => p === 'shorts' || p === 'embed' || p === 'live');
            if (idx >= 0 && parts[idx + 1]) {
                return parts[idx + 1];
            }
        }
    } catch {
        // Ignore parse errors
    }
    return null;
}

async function fetchYouTubeChannel(handle) {
    if (!handle) return null;
    const cleanHandle = handle.replace(/^@/, '').trim();
    if (!cleanHandle) return null;

    const apiKey = getYouTubeApiKey();
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

async function getYouTubeVideoDetails(videoId) {
    if (!videoId) return null;
    const apiKey = getYouTubeApiKey();
    if (!apiKey) return null;

    try {
        const res = await request(
            `https://www.googleapis.com/youtube/v3/videos?` +
            `part=snippet,contentDetails&id=${encodeURIComponent(videoId)}&key=${apiKey}`
        );
        const body = await res.body.json();
        if (!body.items || !body.items.length) return null;
        const item = body.items[0];
        const durationSeconds = parseIsoDurationToSeconds(item.contentDetails?.duration);
        return {
            id: item.id,
            snippet: item.snippet,
            durationSeconds
        };
    } catch (e) {
        logger.error('YouTube API error: ' + (e.stack || e));
        return null;
    }
}

async function searchYouTubeVideo(query) {
    if (!query) return null;
    const apiKey = getYouTubeApiKey();
    if (!apiKey) return null;

    try {
        const res = await request(
            `https://www.googleapis.com/youtube/v3/search?` +
            `part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}&key=${apiKey}`
        );
        const body = await res.body.json();
        if (!body.items || !body.items.length) return null;
        const item = body.items[0];
        const videoId = item.id?.videoId;
        if (!videoId) return null;

        const details = await getYouTubeVideoDetails(videoId);
        if (!details) {
            return { id: videoId, snippet: item.snippet, durationSeconds: null };
        }
        return details;
    } catch (e) {
        logger.error('YouTube API error: ' + (e.stack || e));
        return null;
    }
}

module.exports = {
    fetchYouTubeChannel,
    extractYouTubeVideoId,
    getYouTubeVideoDetails,
    searchYouTubeVideo,
};
