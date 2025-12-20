/**
 * IMAX Scanner Service
 * Handles on-demand scanning of IMAX Melbourne sessions for optimal seating
 */

const { EmbedBuilder } = require('discord.js');
const logger = require('../logger').child('imax-scanner');
const db = require('../database/db');
const {
    scanImaxDate,
    scanImaxMovie,
    quickScanSessions,
    fetchSeatMap,
    findOptimalSeats,
    IMAX_CONFIG,
} = require('../utils/imaxParser');

// Cache configuration
const CACHE_CONFIG = {
    expiryMs: 10 * 60 * 1000,           // 10 minutes default
    almostSoldExpiryMs: 2 * 60 * 1000,  // 2 minutes for almost-sold sessions
    maxCacheSize: 100,                   // Maximum cached results
    cleanupIntervalMs: 5 * 60 * 1000,   // Cleanup every 5 minutes
};

/**
 * LRU-bounded cache with TTL support
 */
class BoundedCache {
    constructor(maxSize = 100) {
        this.maxSize = maxSize;
        this.cache = new Map(); // key -> { value, expiresAt, accessedAt }
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;

        // Check expiration
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return null;
        }

        // Update access time for LRU
        entry.accessedAt = Date.now();
        return entry.value;
    }

    set(key, value, ttlMs = CACHE_CONFIG.expiryMs) {
        // Evict if at capacity
        if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
            this._evictLRU();
        }

        this.cache.set(key, {
            value,
            expiresAt: Date.now() + ttlMs,
            accessedAt: Date.now(),
        });
    }

    has(key) {
        const entry = this.cache.get(key);
        if (!entry) return false;
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return false;
        }
        return true;
    }

    delete(key) {
        return this.cache.delete(key);
    }

    _evictLRU() {
        let oldestKey = null;
        let oldestTime = Infinity;

        for (const [key, entry] of this.cache) {
            if (entry.accessedAt < oldestTime) {
                oldestTime = entry.accessedAt;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.cache.delete(oldestKey);
            logger.debug('Evicted LRU cache entry', { key: oldestKey });
        }
    }

    cleanup() {
        const now = Date.now();
        let expired = 0;

        for (const [key, entry] of this.cache) {
            if (now > entry.expiresAt) {
                this.cache.delete(key);
                expired++;
            }
        }

        if (expired > 0) {
            logger.debug('Cleaned up expired cache entries', { expired, remaining: this.cache.size });
        }
    }

    get size() {
        return this.cache.size;
    }

    clear() {
        this.cache.clear();
    }
}

class ImaxScannerService {
    constructor(client) {
        this.client = client;
        this.scanInProgress = new Map(); // key -> Promise (prevents duplicate scans)
        this.resultsCache = new BoundedCache(CACHE_CONFIG.maxCacheSize);

        // Schedule periodic cache cleanup
        this.cleanupInterval = setInterval(() => {
            this.resultsCache.cleanup();
            this.cleanupCache().catch(() => {}); // Also cleanup DB cache
        }, CACHE_CONFIG.cleanupIntervalMs);
    }

    /**
     * Shutdown the service and cleanup resources
     */
    shutdown() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.resultsCache.clear();
        this.scanInProgress.clear();
    }

    /**
     * Scan all sessions for a date
     * @param {string} date - Date in YYYY-MM-DD format
     * @param {number} numSeats - Number of consecutive seats needed
     * @param {object} options - Scan options
     * @returns {Promise<object>} Scan results
     */
    async scanDate(date, numSeats = 2, options = {}) {
        const cacheKey = `date:${date}-${numSeats}`;

        // Check if scan is already in progress
        if (this.scanInProgress.has(cacheKey)) {
            logger.debug('Scan already in progress, waiting...', { date, numSeats });
            return this.scanInProgress.get(cacheKey);
        }

        // Check in-memory cache
        const cached = this.resultsCache.get(cacheKey);
        if (cached) {
            logger.debug('Returning cached scan results', { date, numSeats });
            return cached;
        }

        // Check database cache
        try {
            const dbCached = await this.getCachedScan(date, numSeats);
            if (dbCached) {
                // Determine TTL based on session status
                const ttl = this._getCacheTTL(dbCached);
                this.resultsCache.set(cacheKey, dbCached, ttl);
                return dbCached;
            }
        } catch (error) {
            logger.warn('Error checking database cache', { error: error.message });
        }

        // Start new scan
        const scanPromise = this._performScan(date, numSeats, options);
        this.scanInProgress.set(cacheKey, scanPromise);

        try {
            const results = await scanPromise;

            // Cache results with appropriate TTL
            const ttl = this._getCacheTTL(results);
            this.resultsCache.set(cacheKey, results, ttl);
            await this.cacheScanResults(date, numSeats, results);

            return results;
        } finally {
            this.scanInProgress.delete(cacheKey);
        }
    }

    /**
     * Calculate cache TTL based on session status
     * Sessions with almost-sold status get shorter TTL
     */
    _getCacheTTL(results) {
        if (!results || !results.sessions) {
            return CACHE_CONFIG.expiryMs;
        }

        // If any session is almost sold, use shorter TTL
        const hasAlmostSold = results.sessions.some(s => s.status === 'almost_sold');
        if (hasAlmostSold) {
            return CACHE_CONFIG.almostSoldExpiryMs;
        }

        return CACHE_CONFIG.expiryMs;
    }

    /**
     * Scan all sessions for a movie
     * @param {string} movieInput - Movie ID or URL containing movie ID
     * @param {number} numSeats - Number of consecutive seats needed
     * @param {object} options - Scan options
     * @param {Function} [options.onProgress] - Callback for progress updates
     * @returns {Promise<object>} Scan results
     */
    async scanMovie(movieInput, numSeats = 2, options = {}) {
        const cacheKey = `movie:${movieInput}-${numSeats}`;

        if (this.scanInProgress.has(cacheKey)) {
            logger.debug('Movie scan already in progress, waiting...', { movieInput, numSeats });
            return this.scanInProgress.get(cacheKey);
        }

        // Check in-memory cache
        const cached = this.resultsCache.get(cacheKey);
        if (cached) {
            logger.debug('Returning cached movie scan results', { movieInput, numSeats });
            return cached;
        }

        // Check database cache for movie scans
        try {
            const dbCached = await this.getCachedMovieScan(movieInput, numSeats);
            if (dbCached) {
                const ttl = this._getCacheTTL(dbCached);
                this.resultsCache.set(cacheKey, dbCached, ttl);
                return dbCached;
            }
        } catch (error) {
            logger.warn('Error checking movie database cache', { error: error.message });
        }

        const scanPromise = this._performMovieScan(movieInput, numSeats, options);
        this.scanInProgress.set(cacheKey, scanPromise);

        try {
            const results = await scanPromise;

            // Cache results with appropriate TTL
            const ttl = this._getCacheTTL(results);
            this.resultsCache.set(cacheKey, results, ttl);
            await this.cacheMovieScanResults(movieInput, numSeats, results);

            return results;
        } finally {
            this.scanInProgress.delete(cacheKey);
        }
    }

    /**
     * Internal scan implementation
     */
    async _performScan(date, numSeats, options) {
        logger.info('Starting IMAX scan', { date, numSeats });

        try {
            const results = await scanImaxDate(date, numSeats, options);
            return results;
        } catch (error) {
            logger.error('IMAX scan failed', { date, error: error.message });
            return {
                date,
                scannedAt: new Date().toISOString(),
                numSeatsRequested: numSeats,
                sessions: [],
                error: error.message,
            };
        }
    }

    /**
     * Internal movie scan implementation
     */
    async _performMovieScan(movieInput, numSeats, options) {
        logger.info('Starting IMAX movie scan', { movieInput, numSeats });

        try {
            const results = await scanImaxMovie(movieInput, numSeats, options);
            return results;
        } catch (error) {
            logger.error('IMAX movie scan failed', { movieInput, error: error.message });
            return {
                movieInput,
                scannedAt: new Date().toISOString(),
                numSeatsRequested: numSeats,
                sessions: [],
                error: error.message,
            };
        }
    }
    /**
     * Quick scan - just get session list without seat maps
     * @param {string} date - Date in YYYY-MM-DD format
     * @returns {Promise<Array>} List of sessions
     */
    async getSessions(date) {
        try {
            return await quickScanSessions(date);
        } catch (error) {
            logger.error('Failed to get sessions', { date, error: error.message });
            throw error;
        }
    }

    /**
     * Scan a single session
     * @param {string} sessionId - Vista session ID
     * @param {number} numSeats - Number of consecutive seats needed
     * @returns {Promise<object>} Session scan result
     */
    async scanSession(sessionId, numSeats = 2) {
        logger.info('Scanning single session', { sessionId, numSeats });

        try {
            const seatMap = await fetchSeatMap(sessionId);
            const optimalSeats = findOptimalSeats(seatMap, numSeats);

            return {
                sessionId,
                scannedAt: new Date().toISOString(),
                numSeatsRequested: numSeats,
                seatMap: {
                    totalSeats: seatMap.totalSeats,
                    availableSeats: seatMap.availableSeats,
                    soldSeats: seatMap.soldSeats,
                    totalRows: seatMap.totalRows,
                },
                rows: seatMap.rows?.map(row => ({
                    label: row.label,
                    totalSeats: row.seats.length,
                    availableSeats: row.seats.filter(s => s.status === 'available').length,
                })),
                optimalGroups: optimalSeats.filter(g => g.isOptimal),
                availableGroups: optimalSeats.filter(g => !g.isOptimal),
                hasOptimal: optimalSeats.some(g => g.isOptimal),
                hasAvailable: optimalSeats.length > 0,
            };
        } catch (error) {
            logger.error('Session scan failed', { sessionId, error: error.message });
            return {
                sessionId,
                scannedAt: new Date().toISOString(),
                error: error.message,
                hasOptimal: false,
                hasAvailable: false,
            };
        }
    }

    /**
     * Get cached scan from database
     */
    async getCachedScan(date, numSeats) {
        try {
            const [rows] = await db.pool.query(
                `SELECT results FROM ImaxScanCache
                 WHERE scanDate = ? AND numSeats = ? AND expiresAt > NOW()
                 ORDER BY scannedAt DESC LIMIT 1`,
                [date, numSeats]
            );

            if (rows.length > 0) {
                return JSON.parse(rows[0].results);
            }
            return null;
        } catch (error) {
            // Table might not exist yet
            logger.debug('Cache query failed', { error: error.message });
            return null;
        }
    }

    /**
     * Cache scan results to database
     */
    async cacheScanResults(date, numSeats, results) {
        try {
            const ttl = this._getCacheTTL(results);
            const expiresAt = new Date(Date.now() + ttl);
            await db.pool.query(
                `INSERT INTO ImaxScanCache (scanDate, numSeats, results, expiresAt)
                 VALUES (?, ?, ?, ?)`,
                [date, numSeats, JSON.stringify(results), expiresAt]
            );
        } catch (error) {
            // Table might not exist yet
            logger.debug('Cache insert failed', { error: error.message });
        }
    }

    /**
     * Get cached movie scan from database
     */
    async getCachedMovieScan(movieInput, numSeats) {
        try {
            const [rows] = await db.pool.query(
                `SELECT results FROM ImaxScanCache
                 WHERE scanDate = ? AND numSeats = ? AND expiresAt > NOW()
                 ORDER BY scannedAt DESC LIMIT 1`,
                [`movie:${movieInput}`, numSeats]
            );

            if (rows.length > 0) {
                return JSON.parse(rows[0].results);
            }
            return null;
        } catch (error) {
            logger.debug('Movie cache query failed', { error: error.message });
            return null;
        }
    }

    /**
     * Cache movie scan results to database
     */
    async cacheMovieScanResults(movieInput, numSeats, results) {
        try {
            const ttl = this._getCacheTTL(results);
            const expiresAt = new Date(Date.now() + ttl);
            await db.pool.query(
                `INSERT INTO ImaxScanCache (scanDate, numSeats, results, expiresAt)
                 VALUES (?, ?, ?, ?)`,
                [`movie:${movieInput}`, numSeats, JSON.stringify(results), expiresAt]
            );
        } catch (error) {
            logger.debug('Movie cache insert failed', { error: error.message });
        }
    }

    /**
     * Clean up expired cache entries
     */
    async cleanupCache() {
        try {
            const result = await db.pool.query('DELETE FROM ImaxScanCache WHERE expiresAt < NOW()');
            if (result[0]?.affectedRows > 0) {
                logger.debug('Cleaned up expired DB cache entries', { count: result[0].affectedRows });
            }
        } catch (error) {
            logger.debug('Cache cleanup failed', { error: error.message });
        }
    }

    /**
     * Format scan results as Discord embed
     * @param {object} results - Scan results
     * @returns {EmbedBuilder}
     */
    formatResultsEmbed(results) {
        const embed = new EmbedBuilder()
            .setTitle(`IMAX Melbourne - Seat Scan`)
            .setColor(results.summary?.sessionsWithOptimal > 0 ? 0x00ff00 : 0xff9900)
            .setTimestamp(new Date(results.scannedAt));

        if (results.error) {
            embed.setDescription(`Error: ${results.error}`);
            return embed;
        }

        const descriptionParts = [];

        if (results.date) {
            const dateFormatted = new Date(results.date).toLocaleDateString('en-AU', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
            });
            descriptionParts.push(`**Date:** ${dateFormatted}`);
        }

        if (results.movieTitle || results.movieId) {
            const movieLabel = results.movieTitle || `Movie ID ${results.movieId}`;
            descriptionParts.push(`**Movie:** ${movieLabel}`);
        }

        descriptionParts.push(`**Looking for:** ${results.numSeatsRequested} consecutive seats`);
        descriptionParts.push('**Optimal zone:** Last 4 rows, center 50%');

        if (results.matchesOnly) {
            descriptionParts.push('**Showing:** Sessions with optimal seating only');
        }

        embed.setDescription(descriptionParts.join('\n'));

        if (!results.sessions || results.sessions.length === 0) {
            embed.addFields({
                name: 'No matches',
                value: `No sessions have ${results.numSeatsRequested} consecutive seats in the optimal zone.`,
                inline: false,
            });

            const summary = results.summary || {};
            embed.setFooter({
                text: `${summary.sessionsWithOptimal || 0} optimal | ${summary.sessionsWithAvailable || 0} available | ${summary.totalSessions || 0} total sessions`,
            });
            return embed;
        }

        // Group sessions by movie
        const movieGroups = new Map();
        for (const session of results.sessions) {
            const movie = session.movie || 'Unknown';
            if (!movieGroups.has(movie)) {
                movieGroups.set(movie, []);
            }
            movieGroups.get(movie).push(session);
        }

        // Add fields for each movie
        for (const [movie, sessions] of movieGroups) {
            let fieldValue = '';

            for (const session of sessions) {
                const datePrefix = session.date ? `${new Date(session.date).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })} ` : '';
                if (session.error) {
                    fieldValue += `**${datePrefix}${session.time}** - Error: ${session.error}\n`;
                    continue;
                }

                const statusIcon = session.hasOptimal ? '🎯' : session.hasAvailable ? '✅' : '❌';

                if (session.hasOptimal) {
                    const optGroup = session.optimalGroups[0];
                    fieldValue += `${statusIcon} **${datePrefix}${session.time}** - Row ${optGroup.row}: ${optGroup.seatCount} seats (CENTER)\n`;
                } else if (session.hasAvailable) {
                    const group = session.availableGroups[0];
                    fieldValue += `${statusIcon} **${datePrefix}${session.time}** - Row ${group.row}: ${group.seatCount} seats\n`;
                } else {
                    fieldValue += `${statusIcon} **${datePrefix}${session.time}** - No groups of ${results.numSeatsRequested} available\n`;
                }

                fieldValue += `  └ [Book Now](${session.url})\n`;
            }

            // Truncate if too long
            if (fieldValue.length > 1000) {
                fieldValue = fieldValue.substring(0, 997) + '...';
            }

            embed.addFields({
                name: `🎬 ${movie}`,
                value: fieldValue || 'No sessions',
                inline: false,
            });
        }

        // Summary footer
        const summary = results.summary || {};
        embed.setFooter({
            text: `${summary.sessionsWithOptimal || 0} optimal | ${summary.sessionsWithAvailable || 0} available | ${summary.totalSessions || 0} total sessions`,
        });

        return embed;
    }

    /**
     * Format session list as Discord embed
     * @param {Array} sessions - List of sessions
     * @param {string} date - Date string
     * @returns {EmbedBuilder}
     */
    formatSessionsEmbed(sessions, date) {
        const embed = new EmbedBuilder()
            .setTitle('IMAX Melbourne - Sessions')
            .setColor(0x0099ff)
            .setTimestamp();

        const dateFormatted = new Date(date).toLocaleDateString('en-AU', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
        });

        embed.setDescription(`**Date:** ${dateFormatted}`);

        if (sessions.length === 0) {
            embed.addFields({
                name: 'No Sessions',
                value: 'No sessions found for this date.',
            });
            return embed;
        }

        // Group by movie
        const movieGroups = new Map();
        for (const session of sessions) {
            const movie = session.movie || 'Unknown';
            if (!movieGroups.has(movie)) {
                movieGroups.set(movie, []);
            }
            movieGroups.get(movie).push(session);
        }

        for (const [movie, movieSessions] of movieGroups) {
            let fieldValue = movieSessions
                .map(s => `**${s.time}**${s.isPremium ? ' (Premium)' : ''} - [Book](${s.url})`)
                .join('\n');

            if (fieldValue.length > 1000) {
                fieldValue = fieldValue.substring(0, 997) + '...';
            }

            embed.addFields({
                name: `🎬 ${movie}`,
                value: fieldValue,
                inline: false,
            });
        }

        embed.setFooter({ text: `${sessions.length} sessions found` });

        return embed;
    }

    /**
     * Format single session result as Discord embed
     * @param {object} result - Session scan result
     * @param {object} sessionInfo - Basic session info
     * @returns {EmbedBuilder}
     */
    formatSessionEmbed(result, sessionInfo = {}) {
        const embed = new EmbedBuilder()
            .setTitle(`IMAX Session - ${sessionInfo.movie || 'Unknown'}`)
            .setColor(result.hasOptimal ? 0x00ff00 : result.hasAvailable ? 0xff9900 : 0xff0000)
            .setTimestamp(new Date(result.scannedAt));

        if (result.error) {
            embed.setDescription(`Error: ${result.error}`);
            return embed;
        }

        const seatMap = result.seatMap || {};
        embed.setDescription(
            `**Time:** ${sessionInfo.time || 'Unknown'}\n` +
            `**Total Seats:** ${seatMap.totalSeats || 0}\n` +
            `**Available:** ${seatMap.availableSeats || 0}\n` +
            `**Sold:** ${seatMap.soldSeats || 0}`
        );

        // Row breakdown
        if (result.rows && result.rows.length > 0) {
            const rowInfo = result.rows
                .slice(-6) // Last 6 rows (back of theatre)
                .reverse()
                .map(r => `Row ${r.label}: ${r.availableSeats}/${r.totalSeats} available`)
                .join('\n');

            embed.addFields({
                name: 'Back Rows Availability',
                value: rowInfo || 'No row data',
                inline: false,
            });
        }

        // Optimal groups
        if (result.optimalGroups && result.optimalGroups.length > 0) {
            const optimalInfo = result.optimalGroups
                .slice(0, 5)
                .map(g => `🎯 Row ${g.row}: ${g.seatCount} consecutive seats (CENTER)`)
                .join('\n');

            embed.addFields({
                name: 'Optimal Seating Groups',
                value: optimalInfo,
                inline: false,
            });
        }

        // Other available groups
        if (result.availableGroups && result.availableGroups.length > 0) {
            const availInfo = result.availableGroups
                .slice(0, 5)
                .map(g => `✅ Row ${g.row}: ${g.seatCount} consecutive seats`)
                .join('\n');

            embed.addFields({
                name: 'Other Available Groups',
                value: availInfo,
                inline: false,
            });
        }

        if (sessionInfo.url) {
            embed.addFields({
                name: 'Book Now',
                value: `[Click here to book](${sessionInfo.url})`,
                inline: false,
            });
        }

        return embed;
    }
}

// Singleton instance
let instance = null;

function getImaxScannerService(client) {
    if (!instance && client) {
        instance = new ImaxScannerService(client);
    }
    return instance;
}

module.exports = {
    ImaxScannerService,
    getImaxScannerService,
};
