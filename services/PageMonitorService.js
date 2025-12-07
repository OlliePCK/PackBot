const { EmbedBuilder } = require('discord.js');
const crypto = require('crypto');
const logger = require('../logger').child('page-monitor');
const db = require('../database/db');

// User agents to rotate through (avoid detection)
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
];

class PageMonitorService {
    constructor(client) {
        this.client = client;
        this.monitors = new Map(); // id -> monitor data
        this.checkIntervals = new Map(); // id -> interval
        this.isRunning = false;
        this.minInterval = 30; // Minimum 30 seconds between checks
        this.maxErrors = 5; // Pause after 5 consecutive errors
    }

    /**
     * Start the page monitor service
     */
    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        
        logger.info('Starting Page Monitor Service');
        
        try {
            // Load all active monitors from database
            const [rows] = await db.pool.query(
                'SELECT * FROM PageMonitors WHERE isActive = TRUE'
            );
            
            for (const monitor of rows) {
                this.scheduleMonitor(monitor);
            }
            
            logger.info(`Loaded ${rows.length} active page monitors`);
        } catch (error) {
            logger.error('Failed to start Page Monitor Service', { error: error.message });
        }
    }

    /**
     * Stop the page monitor service
     */
    stop() {
        this.isRunning = false;
        
        for (const [id, interval] of this.checkIntervals) {
            clearInterval(interval);
        }
        this.checkIntervals.clear();
        this.monitors.clear();
        
        logger.info('Page Monitor Service stopped');
    }

    /**
     * Schedule a monitor for periodic checks
     */
    scheduleMonitor(monitor) {
        // Clear existing interval if any
        if (this.checkIntervals.has(monitor.id)) {
            clearInterval(this.checkIntervals.get(monitor.id));
        }

        this.monitors.set(monitor.id, monitor);
        
        const interval = Math.max(monitor.checkInterval, this.minInterval) * 1000;
        
        // Do an initial check after a short delay (stagger checks)
        const initialDelay = Math.random() * 10000; // 0-10 second random delay
        setTimeout(() => {
            this.checkPage(monitor.id);
        }, initialDelay);
        
        // Schedule recurring checks
        const intervalId = setInterval(() => {
            this.checkPage(monitor.id);
        }, interval);
        
        this.checkIntervals.set(monitor.id, intervalId);
        
        logger.debug(`Scheduled monitor ${monitor.id} (${monitor.name}) - every ${monitor.checkInterval}s`);
    }

    /**
     * Check a page for changes
     */
    async checkPage(monitorId) {
        const monitor = this.monitors.get(monitorId);
        if (!monitor || !this.isRunning) return;

        try {
            const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
            
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout
            
            const response = await fetch(monitor.url, {
                headers: {
                    'User-Agent': userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Cache-Control': 'no-cache',
                },
                signal: controller.signal,
            });
            
            clearTimeout(timeout);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const content = await response.text();
            const contentHash = crypto.createHash('md5').update(content).digest('hex');
            
            // Check for keyword matches if keywords are specified
            let keywordMatch = null;
            if (monitor.keywords) {
                const keywords = monitor.keywords.split(',').map(k => k.trim().toLowerCase());
                const lowerContent = content.toLowerCase();
                
                for (const keyword of keywords) {
                    if (lowerContent.includes(keyword)) {
                        keywordMatch = keyword;
                        break;
                    }
                }
            }

            // Determine if we should alert
            const isFirstCheck = !monitor.lastHash;
            const contentChanged = monitor.lastHash && monitor.lastHash !== contentHash;
            const shouldAlert = !isFirstCheck && contentChanged && (!monitor.keywords || keywordMatch);

            // Update database
            await db.pool.query(
                `UPDATE PageMonitors 
                 SET lastHash = ?, lastChecked = NOW(), errorCount = 0, lastError = NULL
                 ${contentChanged ? ', lastChanged = NOW()' : ''}
                 WHERE id = ?`,
                [contentHash, monitorId]
            );

            // Update local cache
            monitor.lastHash = contentHash;
            monitor.lastChecked = new Date();
            monitor.errorCount = 0;
            if (contentChanged) {
                monitor.lastChanged = new Date();
            }

            // Send alert if needed
            if (shouldAlert) {
                await this.sendAlert(monitor, keywordMatch, content);
            }

            logger.debug(`Checked monitor ${monitorId} (${monitor.name})`, {
                changed: contentChanged,
                alerted: shouldAlert,
                keyword: keywordMatch,
            });

        } catch (error) {
            const errorCount = (monitor.errorCount || 0) + 1;
            
            await db.pool.query(
                'UPDATE PageMonitors SET lastChecked = NOW(), errorCount = ?, lastError = ? WHERE id = ?',
                [errorCount, error.message, monitorId]
            );
            
            monitor.errorCount = errorCount;
            monitor.lastError = error.message;

            logger.warn(`Monitor ${monitorId} (${monitor.name}) error`, { 
                error: error.message,
                errorCount 
            });

            // Pause monitor if too many errors
            if (errorCount >= this.maxErrors) {
                await this.pauseMonitor(monitorId, 'Too many consecutive errors');
            }
        }
    }

    /**
     * Send a change alert to Discord
     */
    async sendAlert(monitor, keywordMatch, content) {
        try {
            const channel = await this.client.channels.fetch(monitor.channelId);
            if (!channel) {
                logger.warn(`Channel ${monitor.channelId} not found for monitor ${monitor.id}`);
                return;
            }

            // Extract page title if possible
            const titleMatch = content.match(/<title>([^<]*)<\/title>/i);
            const pageTitle = titleMatch ? titleMatch[1].trim() : null;

            const embed = new EmbedBuilder()
                .setTitle('🔔 Page Change Detected!')
                .setDescription(`**${monitor.name}** has changed!`)
                .addFields(
                    { name: 'URL', value: monitor.url.length > 1024 ? monitor.url.slice(0, 1021) + '...' : monitor.url },
                    { name: 'Detected At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                )
                .setColor('#00ff00')
                .setTimestamp()
                .setFooter({ text: 'The Pack • Page Monitor', iconURL: this.client.logo });

            if (pageTitle) {
                embed.addFields({ name: 'Page Title', value: pageTitle.slice(0, 256), inline: true });
            }

            if (keywordMatch) {
                embed.addFields({ name: 'Keyword Found', value: `\`${keywordMatch}\``, inline: true });
            }

            // Build message content with optional role ping
            let messageContent = '';
            if (monitor.roleToMention) {
                messageContent = `<@&${monitor.roleToMention}>`;
            }

            await channel.send({
                content: messageContent || undefined,
                embeds: [embed],
            });

            logger.info(`Alert sent for monitor ${monitor.id} (${monitor.name})`);

        } catch (error) {
            logger.error(`Failed to send alert for monitor ${monitor.id}`, { error: error.message });
        }
    }

    /**
     * Add a new monitor
     */
    async addMonitor(data) {
        const [result] = await db.pool.query(
            `INSERT INTO PageMonitors (guildId, channelId, createdBy, name, url, keywords, checkInterval, roleToMention)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                data.guildId,
                data.channelId,
                data.createdBy,
                data.name,
                data.url,
                data.keywords || null,
                data.checkInterval || 60,
                data.roleToMention || null,
            ]
        );

        const [rows] = await db.pool.query('SELECT * FROM PageMonitors WHERE id = ?', [result.insertId]);
        const monitor = rows[0];

        this.scheduleMonitor(monitor);

        logger.info(`Added new monitor: ${data.name}`, { 
            id: result.insertId,
            url: data.url,
            guild: data.guildId 
        });

        return monitor;
    }

    /**
     * Remove a monitor
     */
    async removeMonitor(monitorId, guildId) {
        // Verify guild ownership
        const [rows] = await db.pool.query(
            'SELECT * FROM PageMonitors WHERE id = ? AND guildId = ?',
            [monitorId, guildId]
        );

        if (rows.length === 0) {
            return null;
        }

        // Clear interval
        if (this.checkIntervals.has(monitorId)) {
            clearInterval(this.checkIntervals.get(monitorId));
            this.checkIntervals.delete(monitorId);
        }
        this.monitors.delete(monitorId);

        // Delete from database
        await db.pool.query('DELETE FROM PageMonitors WHERE id = ?', [monitorId]);

        logger.info(`Removed monitor ${monitorId}`);

        return rows[0];
    }

    /**
     * Pause a monitor
     */
    async pauseMonitor(monitorId, reason = null) {
        if (this.checkIntervals.has(monitorId)) {
            clearInterval(this.checkIntervals.get(monitorId));
            this.checkIntervals.delete(monitorId);
        }

        const monitor = this.monitors.get(monitorId);
        if (monitor) {
            monitor.isActive = false;
        }

        await db.pool.query(
            'UPDATE PageMonitors SET isActive = FALSE WHERE id = ?',
            [monitorId]
        );

        logger.info(`Paused monitor ${monitorId}`, { reason });

        // Notify channel if we have monitor data
        if (monitor && reason) {
            try {
                const channel = await this.client.channels.fetch(monitor.channelId);
                if (channel) {
                    const embed = new EmbedBuilder()
                        .setTitle('⏸️ Monitor Paused')
                        .setDescription(`**${monitor.name}** has been paused.`)
                        .addFields({ name: 'Reason', value: reason })
                        .setColor('#ffaa00')
                        .setFooter({ text: 'Use /monitor resume to restart', iconURL: this.client.logo });
                    
                    await channel.send({ embeds: [embed] });
                }
            } catch {}
        }
    }

    /**
     * Resume a monitor
     */
    async resumeMonitor(monitorId, guildId) {
        const [rows] = await db.pool.query(
            'SELECT * FROM PageMonitors WHERE id = ? AND guildId = ?',
            [monitorId, guildId]
        );

        if (rows.length === 0) {
            return null;
        }

        const monitor = rows[0];
        
        // Reset error count
        await db.pool.query(
            'UPDATE PageMonitors SET isActive = TRUE, errorCount = 0, lastError = NULL WHERE id = ?',
            [monitorId]
        );

        monitor.isActive = true;
        monitor.errorCount = 0;
        
        this.scheduleMonitor(monitor);

        logger.info(`Resumed monitor ${monitorId}`);

        return monitor;
    }

    /**
     * Get monitors for a guild
     */
    async getGuildMonitors(guildId) {
        const [rows] = await db.pool.query(
            'SELECT * FROM PageMonitors WHERE guildId = ? ORDER BY createdAt DESC',
            [guildId]
        );
        return rows;
    }

    /**
     * Get a specific monitor
     */
    async getMonitor(monitorId, guildId) {
        const [rows] = await db.pool.query(
            'SELECT * FROM PageMonitors WHERE id = ? AND guildId = ?',
            [monitorId, guildId]
        );
        return rows[0] || null;
    }

    /**
     * Update monitor settings
     */
    async updateMonitor(monitorId, guildId, updates) {
        const allowedFields = ['name', 'url', 'keywords', 'checkInterval', 'roleToMention', 'channelId'];
        const setClauses = [];
        const values = [];

        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key)) {
                setClauses.push(`${key} = ?`);
                values.push(value);
            }
        }

        if (setClauses.length === 0) return null;

        values.push(monitorId, guildId);

        await db.pool.query(
            `UPDATE PageMonitors SET ${setClauses.join(', ')} WHERE id = ? AND guildId = ?`,
            values
        );

        // Reload monitor
        const [rows] = await db.pool.query(
            'SELECT * FROM PageMonitors WHERE id = ? AND guildId = ?',
            [monitorId, guildId]
        );

        if (rows.length > 0 && rows[0].isActive) {
            this.scheduleMonitor(rows[0]);
        }

        return rows[0] || null;
    }
}

module.exports = PageMonitorService;
