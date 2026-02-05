const { getGuildRow } = require('../database/guilds');
const logger = require('../logger').child('guild-cache');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // guildId -> { data, timestamp }

async function getGuildProfile(guildId) {
    const cached = cache.get(guildId);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        return cached.data;
    }

    try {
        const data = await getGuildRow(guildId);
        cache.set(guildId, { data, timestamp: Date.now() });
        return data;
    } catch (error) {
        logger.warn('Failed to load guild profile', { guildId, error: error.message });
        throw error;
    }
}

function invalidateGuildCache(guildId) {
    if (guildId) {
        cache.delete(guildId);
        return;
    }
    cache.clear();
}

module.exports = {
    getGuildProfile,
    invalidateGuildCache,
};
