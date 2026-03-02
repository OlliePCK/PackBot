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

async function getYouTubeVideoDetailsBatch(videoIds) {
    if (!videoIds || !videoIds.length) return [];
    const apiKey = getYouTubeApiKey();
    if (!apiKey) return [];

    try {
        const res = await request(
            `https://www.googleapis.com/youtube/v3/videos?` +
            `part=snippet,contentDetails,statistics&id=${videoIds.join(',')}&key=${apiKey}`
        );
        const body = await res.body.json();
        if (!body.items || !body.items.length) return [];
        return body.items.map(item => ({
            id: item.id,
            snippet: item.snippet,
            durationSeconds: parseIsoDurationToSeconds(item.contentDetails?.duration),
            viewCount: parseInt(item.statistics?.viewCount, 10) || 0
        }));
    } catch (e) {
        logger.error('YouTube API batch error: ' + (e.stack || e));
        return [];
    }
}

function scoreYouTubeResult(details, expectedDurationSeconds, searchQuery = null) {
    let score = 0;
    const channel = (details.snippet?.channelTitle || '').toLowerCase();
    const title = (details.snippet?.title || '').toLowerCase();

    // Official channel indicators (prefer auto-generated audio channels)
    if (channel.endsWith('- topic')) score += 20;
    if (title.includes('official')) score += 10;

    // Prefer explicit over clean versions
    if (/\bclean\b/.test(title)) score -= 10;

    // View count as popularity/legitimacy signal (log scale, capped)
    // 1M views = +15, 100K = +10, 10K = +5, 1K = 0
    if (details.viewCount > 1000) {
        score += Math.min(15, Math.round(Math.log10(details.viewCount / 1000) * 5));
    }

    // Title relevance to search query — penalize wrong songs
    if (searchQuery) {
        const normalize = s => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const stopWords = new Set(['audio', 'official', 'video', 'lyrics', 'music', 'feat', 'ft', 'featuring']);
        const queryTerms = normalize(searchQuery).split(' ')
            .filter(t => t.length > 2 && !stopWords.has(t));

        if (queryTerms.length > 0) {
            const titleNorm = normalize(title);
            let matched = 0;
            for (const term of queryTerms) {
                if (titleNorm.includes(term)) matched++;
            }
            const ratio = matched / queryTerms.length;
            if (ratio >= 0.8) {
                score += 15;
            } else if (ratio <= 0.5) {
                score -= 50; // Heavy penalty: most search terms missing from title
            }
        }
    }

    // Duration matching (most important signal)
    if (expectedDurationSeconds && details.durationSeconds) {
        const diff = Math.abs(details.durationSeconds - expectedDurationSeconds);
        if (diff <= 5) {
            score += 100; // Near-perfect match
        } else if (diff <= 15) {
            score += 80;
        } else if (diff <= 30) {
            score += 50;
        } else {
            score += Math.max(0, 40 - diff); // Degrades with distance
        }
        // Heavy penalty if video is much shorter than expected (likely truncated)
        if (details.durationSeconds < expectedDurationSeconds * 0.6) {
            score -= 200;
        }
    }

    return score;
}

async function searchYouTubeVideo(query, expectedDurationSeconds = null) {
    if (!query) return null;
    const apiKey = getYouTubeApiKey();
    if (!apiKey) return null;

    try {
        const maxResults = expectedDurationSeconds ? 5 : 1;
        const res = await request(
            `https://www.googleapis.com/youtube/v3/search?` +
            `part=snippet&type=video&maxResults=${maxResults}&q=${encodeURIComponent(query)}&key=${apiKey}`
        );
        const body = await res.body.json();
        if (!body.items || !body.items.length) return null;

        const videoIds = body.items.map(item => item.id?.videoId).filter(Boolean);
        if (!videoIds.length) return null;

        // Single result — no scoring needed
        if (videoIds.length === 1) {
            const details = await getYouTubeVideoDetails(videoIds[0]);
            return details || { id: videoIds[0], snippet: body.items[0].snippet, durationSeconds: null };
        }

        // Batch-fetch details for all candidates
        const allDetails = await getYouTubeVideoDetailsBatch(videoIds);
        if (!allDetails.length) {
            // Fallback to first result without details
            return { id: videoIds[0], snippet: body.items[0].snippet, durationSeconds: null };
        }

        // Score and pick the best result
        const scored = allDetails.map(d => ({ details: d, score: scoreYouTubeResult(d, expectedDurationSeconds, query) }));
        scored.sort((a, b) => b.score - a.score);
        const best = scored[0].details;
        const bestScore = scored[0].score;

        const candidatesSummary = scored.map(c => `"${c.details.snippet?.title}" s=${c.score} d=${c.details.durationSeconds}s v=${c.details.viewCount}`).join(' | ');
        logger.info(`YouTube search: picked "${best.snippet?.title}" (score=${bestScore}, duration=${best.durationSeconds}s, views=${best.viewCount}) from ${allDetails.length} candidates for expected ${expectedDurationSeconds}s`);
        logger.debug(`YouTube candidates: ${candidatesSummary}`);
        return best;
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
