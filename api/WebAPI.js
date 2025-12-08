/**
 * PackBot Web API Server
 * Provides REST API and WebSocket for website integration
 */

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const { createServer } = require('http');
const { Server } = require('socket.io');
const logger = require('../logger').child('api');
const db = require('../database/db');

class WebAPI {
    constructor(client) {
        this.client = client;
        this.app = express();
        this.server = createServer(this.app);
        this.io = new Server(this.server, {
            cors: {
                origin: process.env.CORS_ORIGIN || '*',
                methods: ['GET', 'POST']
            }
        });
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
    }
    
    setupMiddleware() {
        // CORS configuration
        this.app.use(cors({
            origin: process.env.CORS_ORIGIN || '*',
            credentials: true
        }));
        
        // JSON body parser
        this.app.use(express.json());
        
        // Session for OAuth
        this.app.use(session({
            secret: process.env.SESSION_SECRET || 'packbot-secret-change-me',
            resave: false,
            saveUninitialized: false,
            cookie: {
                secure: process.env.NODE_ENV === 'production',
                sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
            }
        }));
        
        // Request logging
        this.app.use((req, res, next) => {
            logger.debug(`${req.method} ${req.path}`);
            next();
        });
    }
    
    setupRoutes() {
        const router = express.Router();
        
        // Admin user ID (sees all guilds/data)
        const ADMIN_USER_ID = '101784904152395776';
        
        // ==========================================
        // Authentication Middleware
        // ==========================================
        
        /**
         * Middleware to require authentication
         */
        const requireAuth = (req, res, next) => {
            if (!req.session.user) {
                return res.status(401).json({ 
                    error: 'Authentication required',
                    authenticated: false 
                });
            }
            next();
        };
        
        /**
         * Check if user has access to a guild
         * Admin user (ADMIN_USER_ID) has access to all guilds
         */
        const hasGuildAccess = (user, guildId) => {
            if (user.id === ADMIN_USER_ID) return true;
            return user.guilds.some(g => g.id === guildId);
        };
        
        /**
         * Get user's accessible guild IDs
         * Admin user gets all bot guilds, others get mutual guilds only
         */
        const getUserGuildIds = (user) => {
            if (user.id === ADMIN_USER_ID) {
                return this.client.guilds.cache.map(g => g.id);
            }
            return user.guilds.map(g => g.id);
        };
        
        // ==========================================
        // Public Stats Endpoints (no auth required)
        // ==========================================
        
        /**
         * GET /api/stats
         * Returns bot statistics
         */
        router.get('/stats', (req, res) => {
            const client = this.client;
            
            res.json({
                status: 'online',
                guilds: client.guilds.cache.size,
                users: client.guilds.cache.reduce((acc, g) => acc + g.memberCount, 0),
                uptime: process.uptime(),
                uptimeFormatted: this.formatUptime(process.uptime()),
                ping: client.ws.ping,
                activeVoice: client.subscriptions?.size || 0,
                version: require('../package.json').version || '1.0.0'
            });
        });
        
        /**
         * GET /api/status
         * Simple health check
         */
        router.get('/status', (req, res) => {
            res.json({
                online: this.client.isReady(),
                timestamp: Date.now()
            });
        });
        
        /**
         * GET /api/guilds
         * Returns list of guilds the user has access to (requires auth)
         * Admin user sees all guilds, others see only mutual guilds
         */
        router.get('/guilds', requireAuth, (req, res) => {
            const user = req.session.user;
            const isSuperAdmin = user.id === ADMIN_USER_ID;
            
            let guilds;
            if (isSuperAdmin) {
                // Super admin sees all guilds with admin rights on all
                guilds = this.client.guilds.cache.map(g => ({
                    id: g.id,
                    name: g.name,
                    memberCount: g.memberCount,
                    icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.webp?size=64` : null,
                    isAdmin: true // Super admin has admin on all guilds
                }));
            } else {
                // Regular users only see mutual guilds with their actual permissions
                guilds = user.guilds
                    .filter(g => this.client.guilds.cache.has(g.id))
                    .map(g => {
                        const cachedGuild = this.client.guilds.cache.get(g.id);
                        return {
                            id: g.id,
                            name: g.name,
                            memberCount: cachedGuild?.memberCount || 0,
                            icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.webp?size=64` : null,
                            isAdmin: g.isAdmin || false // Per-guild admin status from Discord permissions
                        };
                    });
            }
            
            // Sort by member count descending
            guilds.sort((a, b) => b.memberCount - a.memberCount);
            
            res.json({ guilds, isSuperAdmin });
        });
        
        // ==========================================
        // Now Playing Endpoints (require auth + guild access)
        // ==========================================
        
        /**
         * GET /api/nowplaying/:guildId
         * Returns current playing track and queue for a guild
         */
        router.get('/nowplaying/:guildId', requireAuth, (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            
            // Check guild access
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            const subscription = this.client.subscriptions?.get(guildId);
            
            if (!subscription) {
                return res.json({
                    playing: false,
                    paused: false,
                    track: null,
                    queue: [],
                    volume: 100,
                    hasPrevious: false,
                    hasNext: false
                });
            }
            
            const currentTrack = subscription.currentTrack;
            let progress = 0;
            
            // Check if paused
            const { AudioPlayerStatus } = require('@discordjs/voice');
            const isPaused = subscription.audioPlayer.state.status === AudioPlayerStatus.Paused;
            
            if (currentTrack && subscription.playbackStartTime) {
                progress = Math.floor((Date.now() - subscription.playbackStartTime) / 1000);
                progress = Math.min(progress, currentTrack.duration || 0);
            }
            
            res.json({
                playing: !!currentTrack,
                paused: isPaused,
                track: currentTrack ? {
                    title: currentTrack.title,
                    artist: currentTrack.artist,
                    url: currentTrack.url,
                    thumbnail: currentTrack.thumbnail,
                    duration: Math.floor(currentTrack.duration || 0),
                    progress: progress,
                    requestedBy: currentTrack.requestedBy?.username || currentTrack.requestedBy?.toString() || 'Unknown'
                } : null,
                queue: subscription.queue.slice(0, 10).map(t => ({
                    title: t.title,
                    artist: t.artist,
                    duration: Math.floor(t.duration || 0),
                    thumbnail: t.thumbnail
                })),
                queueLength: subscription.queue.length,
                volume: subscription.volume,
                repeatMode: subscription.repeatMode,
                autoplay: subscription.autoplay,
                filters: subscription.filters || [],
                hasPrevious: (subscription.history?.length || 0) > 0,
                hasNext: subscription.queue.length > 0
            });
        });
        
        /**
         * GET /api/queue/:guildId
         * Returns full queue for a guild
         */
        router.get('/queue/:guildId', requireAuth, (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            const page = parseInt(req.query.page) || 1;
            const limit = Math.min(parseInt(req.query.limit) || 25, 100);
            
            // Check guild access
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            const subscription = this.client.subscriptions?.get(guildId);
            
            if (!subscription) {
                return res.json({
                    currentTrack: null,
                    queue: [],
                    total: 0,
                    page: 1,
                    pages: 0
                });
            }
            
            const start = (page - 1) * limit;
            const queue = subscription.queue.slice(start, start + limit);
            
            res.json({
                currentTrack: subscription.currentTrack ? {
                    title: subscription.currentTrack.title,
                    artist: subscription.currentTrack.artist,
                    url: subscription.currentTrack.url,
                    thumbnail: subscription.currentTrack.thumbnail,
                    duration: Math.floor(subscription.currentTrack.duration || 0)
                } : null,
                queue: queue.map((t, i) => ({
                    position: start + i + 1,
                    title: t.title,
                    artist: t.artist,
                    duration: Math.floor(t.duration || 0),
                    thumbnail: t.thumbnail
                })),
                total: subscription.queue.length,
                page,
                pages: Math.ceil(subscription.queue.length / limit)
            });
        });
        
        // ==========================================
        // Leaderboard Endpoints (require auth + guild access)
        // ==========================================
        
        /**
         * GET /api/leaderboard/:guildId
         * Returns gaming leaderboard for a guild
         */
        router.get('/leaderboard/:guildId', requireAuth, async (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            const game = req.query.game || null;
            const limit = Math.min(parseInt(req.query.limit) || 25, 100);
            
            // Check guild access
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            try {
                let query, params;
                
                if (game) {
                    query = `
                        SELECT odUserId, odUsername, gameName, totalSeconds 
                        FROM Playtime 
                        WHERE guildId = ? AND gameName = ?
                        ORDER BY totalSeconds DESC
                        LIMIT ?
                    `;
                    params = [guildId, game, limit];
                } else {
                    query = `
                        SELECT odUserId, odUsername, SUM(totalSeconds) as totalSeconds
                        FROM Playtime 
                        WHERE guildId = ?
                        GROUP BY odUserId, odUsername
                        ORDER BY totalSeconds DESC
                        LIMIT ?
                    `;
                    params = [guildId, limit];
                }
                
                const [rows] = await db.pool.query(query, params);
                
                // Get list of games for this guild
                const [games] = await db.pool.query(
                    'SELECT DISTINCT gameName FROM Playtime WHERE guildId = ? ORDER BY gameName',
                    [guildId]
                );
                
                res.json({
                    guildId,
                    game: game || 'all',
                    leaderboard: rows.map((row, i) => ({
                        rank: i + 1,
                        odUserId: row.odUserId,
                        username: row.odUsername,
                        gameName: row.gameName || 'All Games',
                        totalSeconds: row.totalSeconds,
                        formatted: this.formatPlaytime(row.totalSeconds)
                    })),
                    games: games.map(g => g.gameName)
                });
            } catch (error) {
                logger.error('Leaderboard API error', { error: error.message });
                res.status(500).json({ error: 'Failed to fetch leaderboard' });
            }
        });
        
        /**
         * GET /api/leaderboard/:guildId/user/:userId
         * Returns a specific user's playtime stats
         */
        router.get('/leaderboard/:guildId/user/:odUserId', requireAuth, async (req, res) => {
            const { guildId, odUserId } = req.params;
            const user = req.session.user;
            
            // Check guild access
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            try {
                const [rows] = await db.pool.query(
                    `SELECT gameName, totalSeconds, lastPlayed 
                     FROM Playtime 
                     WHERE guildId = ? AND odUserId = ?
                     ORDER BY totalSeconds DESC`,
                    [guildId, odUserId]
                );
                
                const totalSeconds = rows.reduce((acc, r) => acc + r.totalSeconds, 0);
                
                res.json({
                    odUserId,
                    username: rows[0]?.odUsername || 'Unknown',
                    totalSeconds,
                    totalFormatted: this.formatPlaytime(totalSeconds),
                    games: rows.map(r => ({
                        name: r.gameName,
                        seconds: r.totalSeconds,
                        formatted: this.formatPlaytime(r.totalSeconds),
                        lastPlayed: r.lastPlayed
                    }))
                });
            } catch (error) {
                logger.error('User playtime API error', { error: error.message });
                res.status(500).json({ error: 'Failed to fetch user stats' });
            }
        });
        
        // ==========================================
        // Discord OAuth2 Endpoints
        // ==========================================
        
        /**
         * GET /api/auth/discord
         * Redirects to Discord OAuth2
         */
        router.get('/auth/discord', (req, res) => {
            const clientId = process.env.CLIENT_ID;
            const redirectUri = encodeURIComponent(process.env.OAUTH_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/callback`);
            const scope = encodeURIComponent('identify guilds');
            
            const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}`;
            
            res.redirect(authUrl);
        });
        
        /**
         * GET /api/auth/callback
         * OAuth2 callback handler
         */
        router.get('/auth/callback', async (req, res) => {
            const { code } = req.query;
            
            if (!code) {
                return res.redirect(process.env.FRONTEND_URL || '/?error=no_code');
            }
            
            try {
                // Exchange code for token
                const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        client_id: process.env.CLIENT_ID,
                        client_secret: process.env.DISCORD_CLIENT_SECRET,
                        grant_type: 'authorization_code',
                        code,
                        redirect_uri: process.env.OAUTH_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/callback`
                    })
                });
                
                const tokens = await tokenResponse.json();
                
                if (tokens.error) {
                    logger.error('OAuth token error', { error: tokens.error });
                    return res.redirect(process.env.FRONTEND_URL || '/?error=token_error');
                }
                
                // Get user info
                const userResponse = await fetch('https://discord.com/api/users/@me', {
                    headers: { Authorization: `Bearer ${tokens.access_token}` }
                });
                
                const user = await userResponse.json();
                
                // Get user's guilds
                const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
                    headers: { Authorization: `Bearer ${tokens.access_token}` }
                });
                
                const guilds = await guildsResponse.json();
                
                // Store in session
                req.session.user = {
                    id: user.id,
                    odUserId: user.id,
                    username: user.username,
                    discriminator: user.discriminator,
                    avatar: user.avatar,
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                    guilds: guilds.filter(g => this.client.guilds.cache.has(g.id)).map(g => ({
                        id: g.id,
                        name: g.name,
                        icon: g.icon,
                        // Discord returns permissions as a string, need to parse as BigInt for bitwise ops
                        isAdmin: (BigInt(g.permissions) & BigInt(0x8)) === BigInt(0x8)
                    }))
                };
                
                logger.info('User authenticated via OAuth', { userId: user.id, username: user.username });
                
                res.redirect(process.env.FRONTEND_URL || '/dashboard');
                
            } catch (error) {
                logger.error('OAuth callback error', { error: error.message });
                res.redirect(process.env.FRONTEND_URL || '/?error=auth_failed');
            }
        });
        
        /**
         * GET /api/auth/me
         * Returns current authenticated user
         */
        router.get('/auth/me', (req, res) => {
            if (!req.session.user) {
                return res.status(401).json({ authenticated: false });
            }
            
            const user = req.session.user;
            res.json({
                authenticated: true,
                id: user.id,
                username: user.username,
                avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null,
                guilds: user.guilds
            });
        });
        
        /**
         * POST /api/auth/logout
         * Logs out the user
         */
        router.post('/auth/logout', (req, res) => {
            req.session.destroy();
            res.json({ success: true });
        });
        
        // ==========================================
        // User Preferences endpoints
        // ==========================================
        
        /**
         * GET /api/user/preferences
         * Returns user's preferences (favorite guild, etc.)
         */
        router.get('/user/preferences', requireAuth, async (req, res) => {
            const userId = req.session.user.id;
            
            try {
                const [rows] = await db.pool.query(
                    'SELECT * FROM UserPreferences WHERE odUserId = ?',
                    [userId]
                );
                
                if (rows.length === 0) {
                    return res.json({ favoriteGuildId: null });
                }
                
                res.json({
                    favoriteGuildId: rows[0].favoriteGuildId
                });
            } catch (error) {
                logger.error('User preferences GET error', { error: error.message });
                res.status(500).json({ error: 'Failed to fetch preferences' });
            }
        });
        
        /**
         * PUT /api/user/preferences
         * Update user's preferences
         */
        router.put('/user/preferences', requireAuth, async (req, res) => {
            const userId = req.session.user.id;
            const { favoriteGuildId } = req.body;
            
            // Validate that user has access to this guild
            if (favoriteGuildId && !hasGuildAccess(req.session.user, favoriteGuildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            try {
                await db.pool.query(
                    `INSERT INTO UserPreferences (odUserId, favoriteGuildId) 
                     VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE favoriteGuildId = VALUES(favoriteGuildId)`,
                    [userId, favoriteGuildId || null]
                );
                
                res.json({ success: true, favoriteGuildId: favoriteGuildId || null });
            } catch (error) {
                logger.error('User preferences PUT error', { error: error.message });
                res.status(500).json({ error: 'Failed to update preferences' });
            }
        });
        
        // ==========================================
        // User-specific endpoints (requires auth)
        // ==========================================
        
        /**
         * GET /api/user/playlists
         * Returns user's saved playlists across all shared guilds
         */
        router.get('/user/playlists', async (req, res) => {
            if (!req.session.user) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            
            const userId = req.session.user.id;
            const guildIds = req.session.user.guilds.map(g => g.id);
            
            if (guildIds.length === 0) {
                return res.json({ playlists: [] });
            }
            
            try {
                const [rows] = await db.pool.query(
                    `SELECT * FROM SavedPlaylists
                     WHERE userId = ? AND guildId IN (?)
                     ORDER BY name`,
                    [userId, guildIds]
                );
                
                res.json({
                    playlists: rows.map(r => ({
                        id: r.id,
                        guildId: r.guildId,
                        name: r.name,
                        url: r.url,
                        platform: r.platform,
                        createdAt: r.createdAt
                    }))
                });
            } catch (error) {
                logger.error('User playlists API error', { error: error.message });
                res.status(500).json({ error: 'Failed to fetch playlists' });
            }
        });
        
        /**
         * POST /api/user/playlists
         * Create a new saved playlist
         */
        router.post('/user/playlists', async (req, res) => {
            if (!req.session.user) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            
            const { guildId, name, url } = req.body;
            const userId = req.session.user.id;
            
            // Verify user has access to this guild
            if (!req.session.user.guilds.find(g => g.id === guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            // Detect platform
            let platform = 'other';
            if (url.includes('spotify.com')) platform = 'spotify';
            else if (url.includes('youtube.com') || url.includes('youtu.be')) platform = 'youtube';
            else if (url.includes('soundcloud.com')) platform = 'soundcloud';
            
            try {
                await db.pool.query(
                    `INSERT INTO SavedPlaylists (guildId, userId, name, url, platform) 
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE url = VALUES(url), platform = VALUES(platform)`,
                    [guildId, userId, name.toLowerCase(), url, platform]
                );
                
                res.json({ success: true });
            } catch (error) {
                logger.error('Create playlist API error', { error: error.message });
                res.status(500).json({ error: 'Failed to create playlist' });
            }
        });
        
        /**
         * DELETE /api/user/playlists/:id
         * Delete a saved playlist
         */
        router.delete('/user/playlists/:id', async (req, res) => {
            if (!req.session.user) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            
            const playlistId = req.params.id;
            const userId = req.session.user.id;
            
            try {
                const [result] = await db.pool.query(
                    'DELETE FROM SavedPlaylists WHERE id = ? AND userId = ?',
                    [playlistId, userId]
                );
                
                if (result.affectedRows === 0) {
                    return res.status(404).json({ error: 'Playlist not found' });
                }
                
                res.json({ success: true });
            } catch (error) {
                logger.error('Delete playlist API error', { error: error.message });
                res.status(500).json({ error: 'Failed to delete playlist' });
            }
        });
        
        // ==========================================
        // Listening History Endpoints
        // ==========================================
        
        /**
         * GET /api/history/:guildId
         * Returns listening history for a guild with pagination
         */
        router.get('/history/:guildId', requireAuth, async (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            const page = parseInt(req.query.page) || 1;
            const limit = Math.min(parseInt(req.query.limit) || 50, 100);
            const userId = req.query.userId || null;
            
            // Check guild access
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            try {
                let countQuery = 'SELECT COUNT(*) as total FROM ListeningHistory WHERE guildId = ?';
                let historyQuery = `SELECT * FROM ListeningHistory WHERE guildId = ?`;
                const params = [guildId];
                
                if (userId) {
                    countQuery += ' AND odUserId = ?';
                    historyQuery += ' AND odUserId = ?';
                    params.push(userId);
                }
                
                historyQuery += ' ORDER BY playedAt DESC LIMIT ? OFFSET ?';
                
                const [[{ total }]] = await db.pool.query(countQuery, params);
                const [rows] = await db.pool.query(historyQuery, [...params, limit, (page - 1) * limit]);
                
                res.json({
                    history: rows.map(r => ({
                        id: r.id,
                        title: r.trackTitle,
                        artist: r.trackArtist,
                        url: r.trackUrl,
                        thumbnail: r.trackThumbnail,
                        duration: r.durationSeconds,
                        requestedBy: { id: r.odUserId, username: r.odUsername },
                        playedAt: r.playedAt
                    })),
                    total,
                    page,
                    pages: Math.ceil(total / limit)
                });
            } catch (error) {
                logger.error('History API error', { error: error.message });
                res.status(500).json({ error: 'Failed to fetch history' });
            }
        });
        
        /**
         * GET /api/history/:guildId/stats
         * Returns listening statistics for a guild
         */
        router.get('/history/:guildId/stats', requireAuth, async (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            try {
                // Get total tracks played
                const [[{ totalTracks }]] = await db.pool.query(
                    'SELECT COUNT(*) as totalTracks FROM ListeningHistory WHERE guildId = ?',
                    [guildId]
                );
                
                // Get total listening time
                const [[{ totalSeconds }]] = await db.pool.query(
                    'SELECT COALESCE(SUM(durationSeconds), 0) as totalSeconds FROM ListeningHistory WHERE guildId = ?',
                    [guildId]
                );
                
                // Get top 10 tracks
                const [topTracks] = await db.pool.query(
                    `SELECT trackTitle as title, trackArtist as artist, trackUrl as url, trackThumbnail as thumbnail,
                            COUNT(*) as playCount, SUM(durationSeconds) as totalDuration
                     FROM ListeningHistory WHERE guildId = ?
                     GROUP BY trackTitle, trackArtist, trackUrl, trackThumbnail
                     ORDER BY playCount DESC LIMIT 10`,
                    [guildId]
                );
                
                // Get top 10 users
                const [topUsers] = await db.pool.query(
                    `SELECT odUserId as odUserId, odUsername as username,
                            COUNT(*) as playCount, SUM(durationSeconds) as totalDuration
                     FROM ListeningHistory WHERE guildId = ?
                     GROUP BY odUserId, odUsername
                     ORDER BY playCount DESC LIMIT 10`,
                    [guildId]
                );
                
                // Get activity by hour (last 30 days)
                const [hourlyActivity] = await db.pool.query(
                    `SELECT HOUR(playedAt) as hour, COUNT(*) as count
                     FROM ListeningHistory 
                     WHERE guildId = ? AND playedAt > DATE_SUB(NOW(), INTERVAL 30 DAY)
                     GROUP BY HOUR(playedAt)
                     ORDER BY hour`,
                    [guildId]
                );
                
                res.json({
                    totalTracks,
                    totalListeningTime: parseInt(totalSeconds),
                    topTracks,
                    topUsers,
                    hourlyActivity
                });
            } catch (error) {
                logger.error('History stats API error', { error: error.message });
                res.status(500).json({ error: 'Failed to fetch history stats' });
            }
        });
        
        // ==========================================
        // Queue Management Endpoints
        // ==========================================
        
        /**
         * POST /api/queue/:guildId/add
         * Add a song to the queue
         */
        router.post('/queue/:guildId/add', requireAuth, async (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            const { query } = req.body;
            
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            if (!query) {
                return res.status(400).json({ error: 'Query is required' });
            }
            
            const subscription = this.client.subscriptions?.get(guildId);
            if (!subscription) {
                return res.status(400).json({ error: 'No active music session. Start playing from Discord first.' });
            }
            
            try {
                const QueryResolver = require('../music/QueryResolver');
                const tracks = await QueryResolver.handleSearch(query, `<@${user.id}>`);
                
                if (!tracks || tracks.length === 0) {
                    return res.status(404).json({ error: 'No tracks found' });
                }
                
                const track = tracks[0];
                subscription.enqueue(track);
                
                // Log queue action for audit
                logger.info('WEB_QUEUE_ADD', {
                    userId: user.id,
                    username: user.username,
                    guildId,
                    track: track.title,
                    query,
                    queueLength: subscription.queue.length
                });
                
                res.json({
                    success: true,
                    track: {
                        title: track.title,
                        artist: track.artist,
                        duration: track.duration,
                        thumbnail: track.thumbnail,
                        position: subscription.queue.length
                    }
                });
            } catch (error) {
                logger.error('Queue add API error', { error: error.message });
                res.status(500).json({ error: 'Failed to add track' });
            }
        });
        
        /**
         * DELETE /api/queue/:guildId/:position
         * Remove a song from the queue
         */
        router.delete('/queue/:guildId/:position', requireAuth, (req, res) => {
            const { guildId, position } = req.params;
            const user = req.session.user;
            const pos = parseInt(position);
            
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            const subscription = this.client.subscriptions?.get(guildId);
            if (!subscription) {
                return res.status(400).json({ error: 'No active music session' });
            }
            
            if (pos < 1 || pos > subscription.queue.length) {
                return res.status(400).json({ error: 'Invalid position' });
            }
            
            const [removed] = subscription.queue.splice(pos - 1, 1);
            
            // Send queue update via WebSocket
            this.sendQueueUpdate(guildId);
            
            // Log queue action for audit
            logger.info('WEB_QUEUE_REMOVE', {
                userId: user.id,
                username: user.username,
                guildId,
                position: pos,
                removedTrack: removed.title,
                queueLength: subscription.queue.length
            });
            
            res.json({
                success: true,
                removed: {
                    title: removed.title,
                    artist: removed.artist
                }
            });
        });
        
        /**
         * POST /api/queue/:guildId/move
         * Move a song to a new position
         */
        router.post('/queue/:guildId/move', requireAuth, (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            const { from, to } = req.body;
            
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            const subscription = this.client.subscriptions?.get(guildId);
            if (!subscription) {
                return res.status(400).json({ error: 'No active music session' });
            }
            
            const len = subscription.queue.length;
            if (from < 1 || from > len || to < 1 || to > len) {
                return res.status(400).json({ error: 'Invalid positions' });
            }
            
            // Remove from old position and insert at new position
            const [track] = subscription.queue.splice(from - 1, 1);
            subscription.queue.splice(to - 1, 0, track);
            
            // Prefetch if moved to position 1
            if (to === 1) {
                subscription.prefetchTrack(track);
            }
            
            // Send queue update via WebSocket
            this.sendQueueUpdate(guildId);
            
            // Log queue action for audit
            logger.info('WEB_QUEUE_MOVE', {
                userId: user.id,
                username: user.username,
                guildId,
                from,
                to,
                track: track.title
            });
            
            res.json({ success: true });
        });
        
        /**
         * POST /api/queue/:guildId/shuffle
         * Shuffle the queue
         */
        router.post('/queue/:guildId/shuffle', requireAuth, (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            const subscription = this.client.subscriptions?.get(guildId);
            if (!subscription) {
                return res.status(400).json({ error: 'No active music session' });
            }
            
            if (subscription.queue.length < 2) {
                return res.status(400).json({ error: 'Need at least 2 songs in queue to shuffle' });
            }
            
            // Fisher-Yates shuffle
            for (let i = subscription.queue.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [subscription.queue[i], subscription.queue[j]] = [subscription.queue[j], subscription.queue[i]];
            }
            
            // Prefetch the new first track
            if (subscription.queue.length > 0) {
                subscription.prefetchTrack(subscription.queue[0]);
            }
            
            // Send queue update via WebSocket
            this.sendQueueUpdate(guildId);
            
            // Log queue action for audit
            logger.info('WEB_QUEUE_SHUFFLE', {
                userId: user.id,
                username: user.username,
                guildId,
                queueLength: subscription.queue.length
            });
            
            res.json({ success: true });
        });
        
        /**
         * POST /api/queue/:guildId/clear
         * Clear the queue
         */
        router.post('/queue/:guildId/clear', requireAuth, (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            const subscription = this.client.subscriptions?.get(guildId);
            if (!subscription) {
                return res.status(400).json({ error: 'No active music session' });
            }
            
            const count = subscription.queue.length;
            subscription.queue = [];
            
            // Send queue update via WebSocket
            this.sendQueueUpdate(guildId);
            
            // Log queue action for audit
            logger.warn('WEB_QUEUE_CLEAR', {
                userId: user.id,
                username: user.username,
                guildId,
                clearedCount: count
            });
            
            res.json({ success: true, cleared: count });
        });
        
        // ==========================================
        // Playback Control Endpoints
        // ==========================================
        
        /**
         * POST /api/player/:guildId/pause
         * Pause or resume playback
         */
        router.post('/player/:guildId/pause', requireAuth, (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            const subscription = this.client.subscriptions?.get(guildId);
            if (!subscription) {
                return res.status(400).json({ error: 'No active music session' });
            }
            
            const { AudioPlayerStatus } = require('@discordjs/voice');
            const isPaused = subscription.audioPlayer.state.status === AudioPlayerStatus.Paused;
            
            if (isPaused) {
                subscription.audioPlayer.unpause();
                logger.info('WEB_PLAYER_RESUME', { userId: user.id, username: user.username, guildId });
            } else {
                subscription.audioPlayer.pause();
                logger.info('WEB_PLAYER_PAUSE', { userId: user.id, username: user.username, guildId });
            }
            
            // Send updated state
            this.sendNowPlayingUpdate(guildId);
            
            res.json({ success: true, paused: !isPaused });
        });
        
        /**
         * POST /api/player/:guildId/skip
         * Skip to next track
         */
        router.post('/player/:guildId/skip', requireAuth, (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            const subscription = this.client.subscriptions?.get(guildId);
            if (!subscription) {
                return res.status(400).json({ error: 'No active music session' });
            }
            
            if (!subscription.currentTrack) {
                return res.status(400).json({ error: 'Nothing is playing' });
            }
            
            const skipped = subscription.currentTrack;
            subscription.skip({ id: user.id, username: user.username, tag: user.discriminator ? `${user.username}#${user.discriminator}` : user.username });
            
            logger.info('WEB_PLAYER_SKIP', {
                userId: user.id,
                username: user.username,
                guildId,
                skippedTrack: skipped.title
            });
            
            res.json({ success: true, skipped: { title: skipped.title, artist: skipped.artist } });
        });
        
        /**
         * POST /api/player/:guildId/previous
         * Go to previous track
         */
        router.post('/player/:guildId/previous', requireAuth, async (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            const subscription = this.client.subscriptions?.get(guildId);
            if (!subscription) {
                return res.status(400).json({ error: 'No active music session' });
            }
            
            try {
                const previousTrack = await subscription.previous();
                
                logger.info('WEB_PLAYER_PREVIOUS', {
                    userId: user.id,
                    username: user.username,
                    guildId,
                    track: previousTrack.title
                });
                
                // Now playing will be updated via subscription events
                res.json({ success: true, track: { title: previousTrack.title, artist: previousTrack.artist } });
            } catch (error) {
                res.status(400).json({ error: error.message || 'No previous track available' });
            }
        });
        
        /**
         * POST /api/player/:guildId/stop
         * Stop playback and clear queue
         */
        router.post('/player/:guildId/stop', requireAuth, (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            const subscription = this.client.subscriptions?.get(guildId);
            if (!subscription) {
                return res.status(400).json({ error: 'No active music session' });
            }
            
            subscription.stop({ id: user.id, username: user.username });
            
            logger.info('WEB_PLAYER_STOP', {
                userId: user.id,
                username: user.username,
                guildId
            });
            
            res.json({ success: true });
        });
        
        /**
         * GET /api/player/:guildId/status
         * Get current player status (playing/paused/idle)
         */
        router.get('/player/:guildId/status', requireAuth, (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            const subscription = this.client.subscriptions?.get(guildId);
            if (!subscription) {
                return res.json({ status: 'idle', playing: false, paused: false });
            }
            
            const { AudioPlayerStatus } = require('@discordjs/voice');
            const status = subscription.audioPlayer.state.status;
            
            res.json({
                status: status,
                playing: status === AudioPlayerStatus.Playing,
                paused: status === AudioPlayerStatus.Paused,
                hasTrack: !!subscription.currentTrack,
                hasPrevious: subscription.history?.length > 0,
                hasNext: subscription.queue.length > 0
            });
        });
        
        // ==========================================
        // User Profile Endpoints
        // ==========================================
        
        /**
         * GET /api/profile/:userId
         * Returns listening profile for a user
         */
        router.get('/profile/:userId', requireAuth, async (req, res) => {
            const { userId } = req.params;
            const user = req.session.user;
            const guildId = req.query.guildId;
            
            // If guildId specified, check access
            if (guildId && !hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            try {
                // Get accessible guild IDs
                const accessibleGuildIds = guildId ? [guildId] : getUserGuildIds(user);
                const guildPlaceholders = accessibleGuildIds.map(() => '?').join(',');
                
                // Get total stats
                const [[stats]] = await db.pool.query(
                    `SELECT COUNT(*) as totalTracks, 
                            COALESCE(SUM(durationSeconds), 0) as totalSeconds,
                            COUNT(DISTINCT guildId) as guildsActive
                     FROM ListeningHistory 
                     WHERE odUserId = ? AND guildId IN (${guildPlaceholders})`,
                    [userId, ...accessibleGuildIds]
                );
                
                // Get username from most recent entry
                const [[userInfo]] = await db.pool.query(
                    `SELECT odUsername FROM ListeningHistory WHERE odUserId = ? ORDER BY playedAt DESC LIMIT 1`,
                    [userId]
                );
                
                // Get top tracks for this user
                const [topTracks] = await db.pool.query(
                    `SELECT trackTitle as title, trackArtist as artist, trackThumbnail as thumbnail,
                            COUNT(*) as playCount
                     FROM ListeningHistory 
                     WHERE odUserId = ? AND guildId IN (${guildPlaceholders})
                     GROUP BY trackTitle, trackArtist, trackThumbnail
                     ORDER BY playCount DESC LIMIT 10`,
                    [userId, ...accessibleGuildIds]
                );
                
                // Get top artists for this user
                const [topArtists] = await db.pool.query(
                    `SELECT trackArtist as artist, COUNT(*) as playCount
                     FROM ListeningHistory 
                     WHERE odUserId = ? AND trackArtist IS NOT NULL AND guildId IN (${guildPlaceholders})
                     GROUP BY trackArtist
                     ORDER BY playCount DESC LIMIT 10`,
                    [userId, ...accessibleGuildIds]
                );
                
                // Get recent plays
                const [recentPlays] = await db.pool.query(
                    `SELECT trackTitle as title, trackArtist as artist, trackThumbnail as thumbnail,
                            playedAt, durationSeconds
                     FROM ListeningHistory 
                     WHERE odUserId = ? AND guildId IN (${guildPlaceholders})
                     ORDER BY playedAt DESC LIMIT 20`,
                    [userId, ...accessibleGuildIds]
                );
                
                // Calculate badges
                const badges = [];
                if (stats.totalTracks >= 100) badges.push({ name: 'Centurion', icon: '💯', desc: '100+ tracks played' });
                if (stats.totalTracks >= 500) badges.push({ name: 'Audiophile', icon: '🎧', desc: '500+ tracks played' });
                if (stats.totalTracks >= 1000) badges.push({ name: 'Music Legend', icon: '🏆', desc: '1000+ tracks played' });
                if (stats.totalSeconds >= 86400) badges.push({ name: 'Day Tripper', icon: '☀️', desc: '24+ hours of music' });
                if (stats.totalSeconds >= 604800) badges.push({ name: 'Week Warrior', icon: '⚔️', desc: '168+ hours of music' });
                if (stats.guildsActive >= 3) badges.push({ name: 'Nomad', icon: '🌍', desc: 'Active in 3+ servers' });
                
                res.json({
                    userId,
                    username: userInfo?.odUsername || 'Unknown User',
                    stats: {
                        totalTracks: parseInt(stats.totalTracks),
                        totalListeningTime: parseInt(stats.totalSeconds),
                        guildsActive: parseInt(stats.guildsActive)
                    },
                    topTracks,
                    topArtists,
                    recentPlays,
                    badges
                });
            } catch (error) {
                logger.error('Profile API error', { error: error.message });
                res.status(500).json({ error: 'Failed to fetch profile' });
            }
        });
        
        // ==========================================
        // YouTube Channel Management Endpoints
        // ==========================================
        
        /**
         * GET /api/youtube/:guildId
         * Returns list of tracked YouTube channels for a guild
         */
        const self = this; // Store reference for use in route handlers
        router.get('/youtube/:guildId', requireAuth, async (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            
            // Check guild access
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            try {
                const [rows] = await db.pool.query(
                    'SELECT * FROM Youtube WHERE guildId = ? ORDER BY handle',
                    [guildId]
                );
                
                // Fetch channel info from YouTube API for each channel
                const channels = await Promise.all(rows.map(async (r) => {
                    try {
                        const channelData = await self.fetchYouTubeChannel(r.handle);
                        if (channelData) {
                            return {
                                id: r.id,
                                handle: r.handle,
                                channelId: r.channelId,
                                lastChecked: r.lastChecked,
                                title: channelData.snippet?.title,
                                thumbnail: channelData.snippet?.thumbnails?.default?.url,
                                subscriberCount: channelData.statistics?.subscriberCount,
                                videoCount: channelData.statistics?.videoCount
                            };
                        }
                    } catch (e) {
                        logger.warn(`Failed to fetch YouTube data for ${r.handle}`, { error: e.message });
                    }
                    return {
                        id: r.id,
                        handle: r.handle,
                        channelId: r.channelId,
                        lastChecked: r.lastChecked
                    };
                }));
                
                res.json({ channels });
            } catch (error) {
                logger.error('YouTube list API error', { error: error.message });
                res.status(500).json({ error: 'Failed to fetch YouTube channels' });
            }
        });
        
        /**
         * POST /api/youtube/:guildId
         * Add a YouTube channel to track
         */
        router.post('/youtube/:guildId', requireAuth, async (req, res) => {
            const { guildId } = req.params;
            const { handle } = req.body;
            const user = req.session.user;
            
            // Check guild access and admin permission
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            // Only admin can add channels
            if (user.id !== ADMIN_USER_ID) {
                const userGuild = user.guilds.find(g => g.id === guildId);
                if (!userGuild?.isAdmin) {
                    return res.status(403).json({ error: 'Admin permission required' });
                }
            }
            
            if (!handle) {
                return res.status(400).json({ error: 'Handle is required' });
            }
            
            const cleanHandle = handle.replace(/^@/, '');
            
            try {
                // Fetch channel info from YouTube API
                const channelData = await self.fetchYouTubeChannel(cleanHandle);
                if (!channelData) {
                    return res.status(400).json({ error: 'Invalid YouTube handle' });
                }
                
                const { snippet, statistics, id: channelId } = channelData;
                
                // Check if guild has YouTube channel configured
                const [guildRows] = await db.pool.query(
                    'SELECT youtubeChannelID FROM Guilds WHERE guildId = ?',
                    [guildId]
                );
                
                if (!guildRows.length || !guildRows[0].youtubeChannelID) {
                    return res.status(400).json({ 
                        error: 'YouTube notification channel not configured. Set it in Server Settings first.' 
                    });
                }
                
                await db.pool.query(
                    'INSERT INTO Youtube (handle, channelId, guildId, lastChecked) VALUES (?, ?, ?, ?)',
                    [cleanHandle, channelId, guildId, new Date()]
                );
                
                res.json({
                    success: true,
                    channel: {
                        handle: cleanHandle,
                        channelId,
                        name: snippet.title,
                        thumbnail: snippet.thumbnails?.default?.url,
                        subscribers: statistics.subscriberCount,
                        videoCount: statistics.videoCount
                    }
                });
            } catch (error) {
                if (error.code === 'ER_DUP_ENTRY') {
                    return res.status(400).json({ error: 'Channel already tracked' });
                }
                logger.error('YouTube add API error', { error: error.message });
                res.status(500).json({ error: 'Failed to add YouTube channel' });
            }
        });
        
        /**
         * DELETE /api/youtube/:guildId/:handle
         * Remove a tracked YouTube channel
         */
        router.delete('/youtube/:guildId/:handle', requireAuth, async (req, res) => {
            const { guildId, handle } = req.params;
            const user = req.session.user;
            
            // Check guild access and admin permission
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            // Only admin can remove channels
            if (user.id !== ADMIN_USER_ID) {
                const userGuild = user.guilds.find(g => g.id === guildId);
                if (!userGuild?.isAdmin) {
                    return res.status(403).json({ error: 'Admin permission required' });
                }
            }
            
            const cleanHandle = handle.replace(/^@/, '');
            
            try {
                const [result] = await db.pool.query(
                    'DELETE FROM Youtube WHERE handle = ? AND guildId = ?',
                    [cleanHandle, guildId]
                );
                
                if (result.affectedRows === 0) {
                    return res.status(404).json({ error: 'Channel not found' });
                }
                
                res.json({ success: true });
            } catch (error) {
                logger.error('YouTube delete API error', { error: error.message });
                res.status(500).json({ error: 'Failed to remove YouTube channel' });
            }
        });
        
        // ==========================================
        // Page Monitor Endpoints
        // ==========================================
        
        /**
         * GET /api/monitors/:guildId
         * Returns all page monitors for a guild
         */
        router.get('/monitors/:guildId', requireAuth, async (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            
            // Check guild access
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            try {
                const [rows] = await db.pool.query(
                    'SELECT * FROM PageMonitors WHERE guildId = ? ORDER BY createdAt DESC',
                    [guildId]
                );
                
                const guild = this.client.guilds.cache.get(guildId);
                
                // Get channel/role names for each monitor
                const monitors = rows.map(m => {
                    const channel = guild?.channels.cache.get(m.channelId);
                    const role = m.roleToMention ? guild?.roles.cache.get(m.roleToMention) : null;
                    
                    return {
                        id: m.id,
                        name: m.name,
                        url: m.url,
                        keywords: m.keywords,
                        checkInterval: m.checkInterval,
                        channelId: m.channelId,
                        channelName: channel?.name || 'Unknown',
                        roleToMention: m.roleToMention,
                        roleName: role?.name || null,
                        isActive: !!m.isActive,
                        monitorType: m.monitorType || 'auto',
                        errorCount: m.errorCount,
                        lastError: m.lastError,
                        lastChecked: m.lastChecked,
                        lastChanged: m.lastChanged,
                        createdAt: m.createdAt
                    };
                });
                
                // Get available channels and roles for dropdowns
                const availableChannels = guild?.channels.cache
                    .filter(c => c.isTextBased() && !c.isVoiceBased())
                    .map(c => ({ id: c.id, name: c.name })) || [];
                    
                const availableRoles = guild?.roles.cache
                    .filter(r => !r.managed && r.name !== '@everyone')
                    .map(r => ({ id: r.id, name: r.name })) || [];
                
                res.json({ monitors, availableChannels, availableRoles });
            } catch (error) {
                logger.error('Monitors list API error', { error: error.message });
                res.status(500).json({ error: 'Failed to fetch monitors' });
            }
        });
        
        /**
         * POST /api/monitors/:guildId
         * Add a new page monitor
         */
        router.post('/monitors/:guildId', requireAuth, async (req, res) => {
            const { guildId } = req.params;
            const { name, url, keywords, checkInterval, channelId, roleToMention, monitorType } = req.body;
            const user = req.session.user;
            
            // Check guild access and admin permission
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            // Only admin can add monitors
            if (user.id !== ADMIN_USER_ID) {
                const userGuild = user.guilds.find(g => g.id === guildId);
                if (!userGuild?.isAdmin) {
                    return res.status(403).json({ error: 'Admin permission required' });
                }
            }
            
            // Validate required fields
            if (!name || !url || !channelId) {
                return res.status(400).json({ error: 'Name, URL, and channel are required' });
            }
            
            // Validate URL
            try {
                new URL(url);
            } catch {
                return res.status(400).json({ error: 'Invalid URL' });
            }
            
            // Validate interval
            const interval = parseInt(checkInterval) || 60;
            if (interval < 30 || interval > 3600) {
                return res.status(400).json({ error: 'Interval must be between 30 and 3600 seconds' });
            }
            
            // Check monitor limit (max 10 per guild)
            const [countRows] = await db.pool.query(
                'SELECT COUNT(*) as count FROM PageMonitors WHERE guildId = ?',
                [guildId]
            );
            if (countRows[0].count >= 10) {
                return res.status(400).json({ error: 'Maximum 10 monitors per server' });
            }
            
            try {
                // Validate monitor type
                const validTypes = ['auto', 'shopify', 'ticketmaster', 'ticketek', 'axs', 'eventbrite', 'generic'];
                const type = validTypes.includes(monitorType) ? monitorType : 'auto';
                
                const [result] = await db.pool.query(
                    `INSERT INTO PageMonitors (guildId, channelId, createdBy, name, url, keywords, checkInterval, roleToMention, monitorType)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [guildId, channelId, user.id, name, url, keywords || null, interval, roleToMention || null, type]
                );
                
                // Get the created monitor
                const [rows] = await db.pool.query('SELECT * FROM PageMonitors WHERE id = ?', [result.insertId]);
                const monitor = rows[0];
                
                // Schedule the monitor if pageMonitor service is available
                if (this.client.pageMonitor) {
                    this.client.pageMonitor.scheduleMonitor(monitor);
                }
                
                res.json({ success: true, monitor });
            } catch (error) {
                logger.error('Monitor add API error', { error: error.message });
                res.status(500).json({ error: 'Failed to add monitor' });
            }
        });
        
        /**
         * PUT /api/monitors/:guildId/:monitorId
         * Update a page monitor
         */
        router.put('/monitors/:guildId/:monitorId', requireAuth, async (req, res) => {
            const { guildId, monitorId } = req.params;
            const { name, url, keywords, checkInterval, channelId, roleToMention, isActive, monitorType } = req.body;
            const user = req.session.user;
            
            // Check guild access and admin permission
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            // Only admin can update monitors
            if (user.id !== ADMIN_USER_ID) {
                const userGuild = user.guilds.find(g => g.id === guildId);
                if (!userGuild?.isAdmin) {
                    return res.status(403).json({ error: 'Admin permission required' });
                }
            }
            
            try {
                // Verify monitor belongs to guild
                const [existing] = await db.pool.query(
                    'SELECT * FROM PageMonitors WHERE id = ? AND guildId = ?',
                    [monitorId, guildId]
                );
                
                if (!existing.length) {
                    return res.status(404).json({ error: 'Monitor not found' });
                }
                
                // Build update query
                const updates = {};
                if (name !== undefined) updates.name = name;
                if (url !== undefined) {
                    try {
                        new URL(url);
                        updates.url = url;
                    } catch {
                        return res.status(400).json({ error: 'Invalid URL' });
                    }
                }
                if (keywords !== undefined) updates.keywords = keywords || null;
                if (checkInterval !== undefined) {
                    const interval = parseInt(checkInterval);
                    if (interval < 30 || interval > 3600) {
                        return res.status(400).json({ error: 'Interval must be between 30 and 3600 seconds' });
                    }
                    updates.checkInterval = interval;
                }
                if (channelId !== undefined) updates.channelId = channelId;
                if (roleToMention !== undefined) updates.roleToMention = roleToMention || null;
                if (isActive !== undefined) updates.isActive = isActive ? 1 : 0;
                if (monitorType !== undefined) {
                    const validTypes = ['auto', 'shopify', 'ticketmaster', 'ticketek', 'axs', 'eventbrite', 'generic'];
                    if (validTypes.includes(monitorType)) {
                        updates.monitorType = monitorType;
                    }
                }
                
                if (Object.keys(updates).length === 0) {
                    return res.status(400).json({ error: 'No updates provided' });
                }
                
                const setClauses = Object.keys(updates).map(k => `${k} = ?`);
                const values = [...Object.values(updates), monitorId, guildId];
                
                await db.pool.query(
                    `UPDATE PageMonitors SET ${setClauses.join(', ')} WHERE id = ? AND guildId = ?`,
                    values
                );
                
                // Get updated monitor
                const [rows] = await db.pool.query('SELECT * FROM PageMonitors WHERE id = ?', [monitorId]);
                const monitor = rows[0];
                
                // Reschedule or pause monitor
                if (this.client.pageMonitor) {
                    if (monitor.isActive) {
                        this.client.pageMonitor.scheduleMonitor(monitor);
                    } else {
                        this.client.pageMonitor.pauseMonitor(monitorId);
                    }
                }
                
                res.json({ success: true, monitor });
            } catch (error) {
                logger.error('Monitor update API error', { error: error.message });
                res.status(500).json({ error: 'Failed to update monitor' });
            }
        });
        
        /**
         * DELETE /api/monitors/:guildId/:monitorId
         * Remove a page monitor
         */
        router.delete('/monitors/:guildId/:monitorId', requireAuth, async (req, res) => {
            const { guildId, monitorId } = req.params;
            const user = req.session.user;
            
            // Check guild access and admin permission
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            // Only admin can delete monitors
            if (user.id !== ADMIN_USER_ID) {
                const userGuild = user.guilds.find(g => g.id === guildId);
                if (!userGuild?.isAdmin) {
                    return res.status(403).json({ error: 'Admin permission required' });
                }
            }
            
            try {
                // Remove from service first
                if (this.client.pageMonitor) {
                    await this.client.pageMonitor.removeMonitor(parseInt(monitorId), guildId);
                } else {
                    // Manually delete if service not available
                    const [result] = await db.pool.query(
                        'DELETE FROM PageMonitors WHERE id = ? AND guildId = ?',
                        [monitorId, guildId]
                    );
                    
                    if (result.affectedRows === 0) {
                        return res.status(404).json({ error: 'Monitor not found' });
                    }
                }
                
                res.json({ success: true });
            } catch (error) {
                logger.error('Monitor delete API error', { error: error.message });
                res.status(500).json({ error: 'Failed to delete monitor' });
            }
        });
        
        /**
         * POST /api/monitors/:guildId/:monitorId/test
         * Test a monitor by fetching the page now
         */
        router.post('/monitors/:guildId/:monitorId/test', requireAuth, async (req, res) => {
            const { guildId, monitorId } = req.params;
            const user = req.session.user;
            
            // Check guild access
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            // Only admin can test monitors
            if (user.id !== ADMIN_USER_ID) {
                const userGuild = user.guilds.find(g => g.id === guildId);
                if (!userGuild?.isAdmin) {
                    return res.status(403).json({ error: 'Admin permission required' });
                }
            }
            
            try {
                // Verify monitor belongs to guild
                const [rows] = await db.pool.query(
                    'SELECT * FROM PageMonitors WHERE id = ? AND guildId = ?',
                    [monitorId, guildId]
                );
                
                if (!rows.length) {
                    return res.status(404).json({ error: 'Monitor not found' });
                }
                
                const monitor = rows[0];
                
                // Fetch the page
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000);
                
                const response = await fetch(monitor.url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Cache-Control': 'no-cache',
                    },
                    signal: controller.signal,
                });
                
                clearTimeout(timeout);
                
                if (!response.ok) {
                    return res.json({
                        success: false,
                        status: response.status,
                        statusText: response.statusText
                    });
                }
                
                const content = await response.text();
                const titleMatch = content.match(/<title>([^<]*)<\/title>/i);
                const pageTitle = titleMatch ? titleMatch[1].trim() : null;
                
                // Check for keywords if specified
                let keywordsFound = [];
                if (monitor.keywords) {
                    const keywords = monitor.keywords.split(',').map(k => k.trim().toLowerCase());
                    const lowerContent = content.toLowerCase();
                    keywordsFound = keywords.filter(k => lowerContent.includes(k));
                }
                
                res.json({
                    success: true,
                    status: response.status,
                    pageTitle,
                    contentLength: content.length,
                    keywordsFound: keywordsFound.length > 0 ? keywordsFound : null
                });
            } catch (error) {
                res.json({
                    success: false,
                    error: error.name === 'AbortError' ? 'Request timed out' : error.message
                });
            }
        });
        
        // ==========================================
        // Guild Settings Endpoints
        // ==========================================
        
        /**
         * GET /api/settings/:guildId
         * Returns guild settings
         */
        router.get('/settings/:guildId', requireAuth, async (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            
            // Check guild access
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            try {
                const [rows] = await db.pool.query(
                    'SELECT * FROM Guilds WHERE guildId = ?',
                    [guildId]
                );
                
                if (!rows.length) {
                    return res.status(404).json({ error: 'Guild not found' });
                }
                
                const settings = rows[0];
                const guild = this.client.guilds.cache.get(guildId);
                
                // Check if guild is voice whitelisted
                const [whitelistRows] = await db.pool.query(
                    'SELECT 1 FROM VoiceWhitelist WHERE guildId = ?',
                    [guildId]
                );
                const isVoiceWhitelisted = whitelistRows.length > 0;
                
                // Get channel/role names
                const getChannelName = (id) => {
                    if (!id || !guild) return null;
                    const channel = guild.channels.cache.get(id);
                    return channel ? { id, name: channel.name } : { id, name: 'Unknown' };
                };
                
                const getRoleName = (id) => {
                    if (!id || !guild) return null;
                    const role = guild.roles.cache.get(id);
                    return role ? { id, name: role.name } : { id, name: 'Unknown' };
                };
                
                res.json({
                    guildId: settings.guildId,
                    guildName: guild?.name || 'Unknown',
                    liveRole: getRoleName(settings.liveRoleID),
                    liveChannel: getChannelName(settings.liveChannelID),
                    generalChannel: getChannelName(settings.generalChannelID),
                    youtubeChannel: getChannelName(settings.youtubeChannelID),
                    twentyFourSevenMode: !!settings.twentyFourSevenMode,
                    voiceCommandsEnabled: !!settings.voiceCommandsEnabled,
                    isVoiceWhitelisted,
                    // Include available channels and roles for dropdowns
                    availableChannels: guild?.channels.cache
                        .filter(c => c.isTextBased() && !c.isVoiceBased())
                        .map(c => ({ id: c.id, name: c.name })) || [],
                    availableRoles: guild?.roles.cache
                        .filter(r => !r.managed && r.name !== '@everyone')
                        .map(r => ({ id: r.id, name: r.name })) || []
                });
            } catch (error) {
                logger.error('Settings get API error', { error: error.message });
                res.status(500).json({ error: 'Failed to fetch settings' });
            }
        });
        
        /**
         * PUT /api/settings/:guildId
         * Update guild settings
         */
        router.put('/settings/:guildId', requireAuth, async (req, res) => {
            const { guildId } = req.params;
            const user = req.session.user;
            const { setting, value } = req.body;
            
            // Check guild access and admin permission
            if (!hasGuildAccess(user, guildId)) {
                return res.status(403).json({ error: 'No access to this guild' });
            }
            
            // Only admin can change settings
            if (user.id !== ADMIN_USER_ID) {
                const userGuild = user.guilds.find(g => g.id === guildId);
                if (!userGuild?.isAdmin) {
                    return res.status(403).json({ error: 'Admin permission required' });
                }
            }
            
            // Validate setting name
            const allowedSettings = {
                'liveRole': 'liveRoleID',
                'liveChannel': 'liveChannelID',
                'generalChannel': 'generalChannelID',
                'youtubeChannel': 'youtubeChannelID',
                'twentyFourSevenMode': 'twentyFourSevenMode',
                'voiceCommandsEnabled': 'voiceCommandsEnabled'
            };
            
            const column = allowedSettings[setting];
            if (!column) {
                return res.status(400).json({ error: 'Invalid setting' });
            }
            
            try {
                // Voice commands setting requires whitelist
                if (setting === 'voiceCommandsEnabled') {
                    const [whitelistRows] = await db.pool.query(
                        'SELECT 1 FROM VoiceWhitelist WHERE guildId = ?',
                        [guildId]
                    );
                    if (whitelistRows.length === 0) {
                        return res.status(403).json({ error: 'Voice commands not available for this server' });
                    }
                }
                
                // Handle boolean toggle
                let dbValue = value;
                if (setting === 'twentyFourSevenMode' || setting === 'voiceCommandsEnabled') {
                    dbValue = value ? 1 : 0;
                }
                
                await db.pool.query(
                    `UPDATE Guilds SET ${column} = ? WHERE guildId = ?`,
                    [dbValue || null, guildId]
                );
                
                res.json({ success: true, setting, value: dbValue });
            } catch (error) {
                logger.error('Settings update API error', { error: error.message });
                res.status(500).json({ error: 'Failed to update setting' });
            }
        });
        
        // ==========================================
        // Shopify Product Lookup Endpoint
        // ==========================================
        
        /**
         * POST /api/shopify/lookup
         * Fetch Shopify product information
         */
        router.post('/shopify/lookup', requireAuth, async (req, res) => {
            const { url: productUrl } = req.body;
            
            if (!productUrl) {
                return res.status(400).json({ error: 'URL is required' });
            }
            
            let url;
            try {
                url = new URL(productUrl);
            } catch {
                return res.status(400).json({ error: 'Invalid URL' });
            }
            
            if (!url.pathname.includes('/products/')) {
                return res.status(400).json({ error: 'Not a valid Shopify product URL' });
            }
            
            try {
                const response = await fetch(`${url.origin}${url.pathname}.json`);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const data = await response.json();
                const product = data.product;
                
                if (!product || !Array.isArray(product.variants)) {
                    return res.status(400).json({ error: 'No product data found' });
                }
                
                res.json({
                    title: product.title,
                    vendor: product.vendor,
                    productType: product.product_type,
                    image: product.images?.[0]?.src,
                    variants: product.variants.map(v => ({
                        id: v.id,
                        title: [v.option1, v.option2, v.option3]
                            .filter(o => o && o !== 'Default Title' && o !== '-')
                            .join(' / ') || 'Default',
                        price: v.price,
                        compareAtPrice: v.compare_at_price,
                        stock: v.inventory_quantity,
                        available: v.available,
                        addToCart: `${url.origin}/cart/${v.id}:1`
                    }))
                });
            } catch (error) {
                logger.error('Shopify lookup error', { error: error.message });
                res.status(500).json({ error: 'Failed to fetch product data' });
            }
        });
        
        // Mount router
        this.app.use('/api', router);
        
        // 404 handler
        this.app.use('/api/*', (req, res) => {
            res.status(404).json({ error: 'Not found' });
        });
    }
    
    setupWebSocket() {
        this.io.on('connection', (socket) => {
            logger.debug('WebSocket client connected', { id: socket.id });
            
            // Join a guild's room to receive updates
            socket.on('subscribe', (guildId) => {
                // Verify the guild exists
                if (this.client.guilds.cache.has(guildId)) {
                    socket.join(`guild:${guildId}`);
                    logger.debug('Client subscribed to guild', { socketId: socket.id, guildId });
                    
                    // Send initial state
                    this.sendNowPlayingUpdate(guildId);
                }
            });
            
            socket.on('unsubscribe', (guildId) => {
                socket.leave(`guild:${guildId}`);
            });
            
            socket.on('disconnect', () => {
                logger.debug('WebSocket client disconnected', { id: socket.id });
            });
        });
    }
    
    /**
     * Send now playing update to all clients in a guild room
     */
    sendNowPlayingUpdate(guildId) {
        const subscription = this.client.subscriptions?.get(guildId);
        
        const data = {
            playing: false,
            paused: false,
            track: null,
            queue: [],
            queueLength: 0,
            volume: 100,
            hasPrevious: false,
            hasNext: false
        };
        
        if (subscription) {
            const track = subscription.currentTrack;
            let progress = 0;
            
            // Check if paused
            const { AudioPlayerStatus } = require('@discordjs/voice');
            const isPaused = subscription.audioPlayer.state.status === AudioPlayerStatus.Paused;
            
            if (track && subscription.playbackStartTime) {
                progress = Math.floor((Date.now() - subscription.playbackStartTime) / 1000);
            }
            
            data.playing = !!track;
            data.paused = isPaused;
            data.track = track ? {
                title: track.title,
                artist: track.artist,
                url: track.url,
                thumbnail: track.thumbnail,
                duration: Math.floor(track.duration || 0),
                progress,
                requestedBy: track.requestedBy?.username || 'Unknown'
            } : null;
            // Send first 20 queue items for real-time updates
            data.queue = subscription.queue.slice(0, 20).map((t, i) => ({
                position: i + 1,
                title: t.title,
                artist: t.artist,
                duration: Math.floor(t.duration || 0),
                thumbnail: t.thumbnail,
                requestedBy: t.requestedBy?.username || 'Unknown'
            }));
            data.queueLength = subscription.queue.length;
            data.volume = subscription.volume;
            data.repeatMode = subscription.repeatMode;
            data.hasPrevious = (subscription.history?.length || 0) > 0;
            data.hasNext = subscription.queue.length > 0;
        }
        
        this.io.to(`guild:${guildId}`).emit('nowplaying', data);
    }
    
    /**
     * Send queue update to all clients in a guild room
     */
    sendQueueUpdate(guildId) {
        const subscription = this.client.subscriptions?.get(guildId);
        
        if (!subscription) {
            this.io.to(`guild:${guildId}`).emit('queueUpdate', { queue: [], total: 0 });
            return;
        }
        
        const data = {
            queue: subscription.queue.slice(0, 50).map((t, i) => ({
                position: i + 1,
                title: t.title,
                artist: t.artist,
                duration: Math.floor(t.duration || 0),
                thumbnail: t.thumbnail,
                requestedBy: t.requestedBy?.username || 'Unknown'
            })),
            total: subscription.queue.length
        };
        
        this.io.to(`guild:${guildId}`).emit('queueUpdate', data);
    }
    
    /**
     * Start the API server
     */
    start(port = 3000) {
        this.server.listen(port, () => {
            logger.info(`Web API server running on port ${port}`);
        });
        
        // Hook into subscription events to send real-time updates
        this.setupSubscriptionHooks();
    }
    
    /**
     * Set up hooks to emit WebSocket events when music state changes
     */
    setupSubscriptionHooks() {
        // We'll add event listeners to subscriptions when they're created
        // This is called periodically to catch new subscriptions
        setInterval(() => {
            if (!this.client.subscriptions) return;
            
            for (const [guildId, subscription] of this.client.subscriptions) {
                if (!subscription._apiHooked) {
                    subscription._apiHooked = true;
                    
                    subscription.on('playSong', () => {
                        this.sendNowPlayingUpdate(guildId);
                        this.sendQueueUpdate(guildId);
                    });
                    
                    subscription.on('addSong', () => {
                        this.sendNowPlayingUpdate(guildId);
                        this.sendQueueUpdate(guildId);
                    });
                    
                    subscription.on('skip', () => {
                        // Send immediate update to clear old track, then another after new track loads
                        this.sendNowPlayingUpdate(guildId);
                        this.sendQueueUpdate(guildId);
                        setTimeout(() => {
                            this.sendNowPlayingUpdate(guildId);
                            this.sendQueueUpdate(guildId);
                        }, 500);
                        setTimeout(() => {
                            this.sendNowPlayingUpdate(guildId);
                            this.sendQueueUpdate(guildId);
                        }, 1500);
                    });
                    
                    subscription.on('stop', () => {
                        this.sendNowPlayingUpdate(guildId);
                        this.sendQueueUpdate(guildId);
                    });
                    
                    subscription.on('finish', () => {
                        this.sendNowPlayingUpdate(guildId);
                        this.sendQueueUpdate(guildId);
                    });
                    
                    subscription.on('queueUpdate', () => {
                        this.sendQueueUpdate(guildId);
                    });
                }
            }
        }, 5000);
    }
    
    // Helper methods
    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        
        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        
        return parts.join(' ') || '< 1m';
    }
    
    formatPlaytime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        
        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        }
        return `${minutes}m`;
    }
    
    /**
     * Fetch YouTube channel data by handle
     */
    async fetchYouTubeChannel(handle) {
        try {
            const { request } = require('undici');
            const res = await request(
                `https://www.googleapis.com/youtube/v3/channels?` +
                `part=snippet,statistics&forHandle=@${handle}&key=${process.env.YOUTUBE_API_KEY}`
            );
            const body = await res.body.json();
            if (!body.items || !body.items.length) {
                // Try by username as fallback
                const res2 = await request(
                    `https://www.googleapis.com/youtube/v3/channels?` +
                    `part=snippet,statistics&forUsername=${handle}&key=${process.env.YOUTUBE_API_KEY}`
                );
                const body2 = await res2.body.json();
                if (!body2.items || !body2.items.length) return null;
                const { snippet, statistics, id } = body2.items[0];
                return { snippet, statistics, id };
            }
            const { snippet, statistics, id } = body.items[0];
            return { snippet, statistics, id };
        } catch (e) {
            logger.error('YouTube API error: ' + (e.stack || e));
            return null;
        }
    }
}

module.exports = WebAPI;
