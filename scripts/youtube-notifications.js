// scripts/youtube-notifications.js (rewritten with single-latest polling & backoff)
const db = require('../database/db.js');
const axios = require('axios');
const pLimit = require('p-limit').default;
const cron = require('node-cron');
const { EmbedBuilder } = require('discord.js');
const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('../logger').child('youtube');

module.exports = client => {
    // Base interval is cron every 30m; per-channel exponential backoff skips cycles.
    const BASE_CRON = '*/30 * * * *';
    const BASE_INTERVAL_MINUTES = 30; // matches cron
    const MAX_BACKOFF_MULTIPLIER = parseInt(process.env.YT_MAX_BACKOFF_MULTIPLIER || '8', 10); // up to 4h (30*8)
    const CONCURRENCY = 5;
    const limit = pLimit(CONCURRENCY);

    // In‑memory per channel backoff state: channelId -> { missCount, skipsRemaining }
    const backoffState = new Map();
    // Cross-cycle notification suppression: notifyChannelId:videoId -> lastSentDate
    const lastNotified = new Map();

    function nextSkips(missCount) {
        // missCount starts at 0 when we have a hit (new video). When there is no new video we increment first.
        const mult = Math.min(2 ** missCount, MAX_BACKOFF_MULTIPLIER); // 1,2,4,8,... capped
        // We already spent one cycle checking; skipsRemaining is mult-1 additional cycles to skip.
        return mult - 1;
    }

    // Build an update row (without lastChecked, which is handled via NOW() in SQL)
    function buildUpdateRow(handle, channelId, guildId, videoId, initializedFlag) {
        return [handle, channelId, guildId, videoId, initializedFlag];
    }

    async function loadWatchList() {
        const [rows] = await db.pool.query(`
    SELECT y.handle,
         y.channelId,
             y.guildId,
             y.lastCheckedVideo,
             y.initialized,
             g.youtubeChannelID AS notifyChannel
        FROM Youtube y
        JOIN Guilds  g ON g.guildId = y.guildId
       WHERE g.youtubeChannelID IS NOT NULL
    `);
        // Collapse accidental duplicate rows (e.g., if table lacks UNIQUE constraint) per (channelId,guildId)
        const grouped = {};
        for (const row of rows) {
            const list = (grouped[row.channelId] ||= []);
            const existingIndex = list.findIndex(r => r.guildId === row.guildId);
            if (existingIndex === -1) {
                list.push(row);
            } else {
                const existing = list[existingIndex];
                // Prefer row with a lastCheckedVideo (non-null) and initialized flag
                const preferNew = (
                    (!existing.lastCheckedVideo && row.lastCheckedVideo) ||
                    (existing.initialized === 0 && row.initialized === 1)
                );
                if (preferNew) list[existingIndex] = row; // replace
            }
        }
        return grouped;
    }

    // Track proxy failures to avoid repeated failures
    let proxyFailureCount = 0;
    const PROXY_FAILURE_THRESHOLD = 3;
    let lastProxyReset = Date.now();

    async function fetchLatestVideo(channelId) {
        const proxyUrl = process.env.PROXY_URL;
        const url = `https://www.googleapis.com/youtube/v3/search`+
            `?part=snippet&channelId=${channelId}`+
            `&order=date&type=video&maxResults=1`+
            `&key=${process.env.YOUTUBE_API_KEY}`;

        // Reset proxy failure count after 30 minutes
        if (Date.now() - lastProxyReset > 30 * 60 * 1000) {
            proxyFailureCount = 0;
            lastProxyReset = Date.now();
        }

        // Skip proxy if it's been failing consistently
        const useProxy = proxyUrl && proxyFailureCount < PROXY_FAILURE_THRESHOLD;
        const agent = useProxy ? new HttpsProxyAgent(proxyUrl) : undefined;

        try {
            const res = await axios.get(url, {
                httpsAgent: agent,
                timeout: 15000
            });
            // Reset failure count on success with proxy
            if (useProxy) proxyFailureCount = 0;
            const item = res.data.items && res.data.items[0];
            if (!item) return null;
            return {
                videoId: item.id.videoId,
                snippet: item.snippet,
                publishedAt: new Date(item.snippet.publishedAt),
            };
        } catch (err) {
            const status = err.response?.status;
            if (status === 403) {
                record403(channelId, err);
            } else if (status === 407) {
                // Proxy authentication required - proxy credentials may be invalid
                proxyFailureCount++;
                if (proxyFailureCount >= PROXY_FAILURE_THRESHOLD) {
                    logger.warn(`Proxy auth failed ${PROXY_FAILURE_THRESHOLD} times, bypassing proxy for this cycle`);
                }
                logger.error(`YouTube fetch error for ${channelId}: Proxy authentication failed (407)`);
            } else {
                logger.error(`YouTube fetch error for ${channelId}: ${err.message}`);
            }
            return null;
        }
    }

    async function sendNotification(discordClient, notifyChannelId, video) {
        const channel = await discordClient.channels.fetch(notifyChannelId).catch(() => null);
        if (!channel?.isTextBased()) return;
        const embed = new EmbedBuilder()
            .setTitle(video.snippet.title)
            .setURL(`https://www.youtube.com/watch?v=${video.videoId}`)
            .setThumbnail(video.snippet.thumbnails?.high?.url || video.snippet.thumbnails?.default?.url)
            .setDescription(`**${video.snippet.channelTitle}** uploaded a new video!`)
            .setColor('#ff006a')
            .setFooter({ text: 'The Pack', iconURL: client.logo });
        await channel.send({ content: `🔔 New video: https://www.youtube.com/watch?v=${video.videoId}`, embeds: [embed] });
    }

    // 403 aggregation
    const forbiddenStats = { total: 0, channels: new Map(), first: null, timer: null };
    function record403(channelId) {
        forbiddenStats.total++;
        forbiddenStats.channels.set(channelId, (forbiddenStats.channels.get(channelId) || 0) + 1);
        if (!forbiddenStats.first) forbiddenStats.first = new Date();
        if (forbiddenStats.total % 25 === 0) flush403('intermediate');
        if (!forbiddenStats.timer) forbiddenStats.timer = setTimeout(() => flush403('timeout'), 5 * 60_000).unref();
    }
    function flush403(reason) {
        if (!forbiddenStats.total) return;
        const chanSummary = [...forbiddenStats.channels.entries()].map(([id, c]) => `${id}:${c}`).join(', ');
        logger.warn(`YouTube 403 summary (${reason}) total=${forbiddenStats.total} since=${forbiddenStats.first.toISOString()} channels=[${chanSummary}]`);
        forbiddenStats.total = 0; forbiddenStats.channels.clear(); forbiddenStats.first = null;
        if (forbiddenStats.timer) { clearTimeout(forbiddenStats.timer); forbiddenStats.timer = null; }
    }
    process.on('beforeExit', () => flush403('exit'));

    async function processChannel(channelId, group) {
        // Respect backoff
        const state = backoffState.get(channelId) || { missCount: 0, skipsRemaining: 0 };
        if (state.skipsRemaining > 0) {
            state.skipsRemaining--;
            backoffState.set(channelId, state);
            return []; // skip API call this cycle
        }

        const latest = await fetchLatestVideo(channelId);
        if (!latest) {
            // treat as miss to gradually back off if persistent failures
            state.missCount = Math.min(state.missCount + 1, 10);
            state.skipsRemaining = nextSkips(state.missCount);
            backoffState.set(channelId, state);
            return [];
        }

        const updates = [];
        let anyNew = false;
        // Per-channel cycle dedupe to avoid sending same video multiple times if duplicates slipped through
        const cycleNotified = new Set();
        for (const row of group) {
            const { handle, guildId, lastCheckedVideo, initialized, notifyChannel } = row;
            // Seed without notifying: set initialized=0 so we know first real notification hasn't occurred yet
            if (!initialized || !lastCheckedVideo) {
                updates.push(buildUpdateRow(handle, channelId, guildId, latest.videoId, 0));
                continue;
            }
            if (lastCheckedVideo === latest.videoId) continue; // nothing new
            // New video detected -> notify and mark initialized=1
            const dedupeKey = `${notifyChannel}:${latest.videoId}`;
            if (lastNotified.get(dedupeKey) === latest.videoId || cycleNotified.has(dedupeKey)) {
                // Already sent; just update DB
                logger.debug(`Duplicate notification suppressed for video ${latest.videoId} notifyChannel ${notifyChannel}`);
            } else {
                try {
                    await sendNotification(client, notifyChannel, latest);
                    lastNotified.set(dedupeKey, latest.videoId);
                    cycleNotified.add(dedupeKey);
                } catch (e) {
                    logger.error(`Notify failed guild=${guildId} channel=${channelId}: ${e.message}`);
                }
            }
            updates.push(buildUpdateRow(handle, channelId, guildId, latest.videoId, 1));
            anyNew = true;
        }

        if (anyNew) {
            state.missCount = 0;
            state.skipsRemaining = 0;
        } else {
            state.missCount = Math.min(state.missCount + 1, 10);
            state.skipsRemaining = nextSkips(state.missCount);
        }
        backoffState.set(channelId, state);
        return updates;
    }

    async function checkAll() {
        logger.info('🔍 YouTube check cycle start');
        const watchList = await loadWatchList();
        const tasks = Object.entries(watchList).map(([channelId, group]) => limit(() => processChannel(channelId, group)));
        const results = await Promise.all(tasks);
        const updates = results.flat();
        if (updates.length) {
            try {
                // Build VALUES clause using NOW() for lastChecked
                const valuesSql = updates.map(() => '(?,?,?,?,?,NOW())').join(',');
                const flat = updates.flat(); // each row has 5 params
                await db.pool.query(
                    `INSERT INTO Youtube (handle, channelId, guildId, lastCheckedVideo, initialized, lastChecked)
                     VALUES ${valuesSql}
                     ON DUPLICATE KEY UPDATE
                       lastCheckedVideo = VALUES(lastCheckedVideo),
                       initialized      = VALUES(initialized),
                       lastChecked      = NOW()`,
                    flat
                );
                logger.info(`✅ Updated ${updates.length} row(s).`);
            } catch (e) {
                logger.error('❌ DB upsert failed (YouTube): ' + e.message);
            }
        } else {
            logger.debug('No DB updates this cycle.');
        }
        logger.info('✅ YouTube check cycle end');
    }

    cron.schedule(BASE_CRON, () => {
        checkAll().catch(e => logger.error('Cycle error: ' + e.message));
    });
    logger.info(`🗓️ Scheduled YouTube checks every ${BASE_INTERVAL_MINUTES} minutes with backoff up to ${BASE_INTERVAL_MINUTES * MAX_BACKOFF_MULTIPLIER} minutes.`);
};