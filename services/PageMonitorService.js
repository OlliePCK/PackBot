/**
 * Enhanced Page Monitor Service with site-specific parsing
 * Supports Shopify, Ticketmaster, Ticketek, AXS, Eventbrite, and generic pages
 */

const { EmbedBuilder } = require('discord.js');
const crypto = require('crypto');
const logger = require('../logger').child('page-monitor');
const db = require('../database/db');
const { parseSite, detectChanges, detectSiteType, getSupportedSiteTypes, closeBrowserClient } = require('../utils/siteParsers');

class PageMonitorService {
    constructor(client) {
        this.client = client;
        this.monitors = new Map(); // id -> monitor data
        this.parsedData = new Map(); // id -> last parsed data (for smart comparison)
        this.checkIntervals = new Map(); // id -> interval
        this.requiresBrowser = new Set(); // monitor IDs that need browser-based fetching
        this.inFlightChecks = new Set(); // monitor IDs currently being checked (prevents overlap)
        this.backoffUntil = new Map(); // id -> timestamp (ms) until next allowed check
        this.softErrorStreak = new Map(); // id -> consecutive soft errors (e.g. anti-bot blocks)
        this.isRunning = false;
        this.minInterval = 30; // Minimum 30 seconds between checks
        this.maxErrors = 5; // Pause after 5 consecutive errors
        this.softBackoffBaseMs = 5 * 60 * 1000; // 5 minutes
        this.softBackoffMaxMs = 60 * 60 * 1000; // 60 minutes
    }

    /**
     * Start the page monitor service
     */
    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        
        logger.info('Starting Enhanced Page Monitor Service');
        
        try {
            // Load all active monitors from database
            const [rows] = await db.pool.query(
                'SELECT * FROM PageMonitors WHERE isActive = TRUE'
            );
            
            for (const monitor of rows) {
                // Load cached parsed data if available
                if (monitor.lastParsedData) {
                    try {
                        this.parsedData.set(monitor.id, JSON.parse(monitor.lastParsedData));
                    } catch {}
                }
                // Track monitors that require browser
                if (monitor.requiresBrowser) {
                    this.requiresBrowser.add(monitor.id);
                }
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
    async stop() {
        this.isRunning = false;

        for (const [id, interval] of this.checkIntervals) {
            clearInterval(interval);
        }
        this.checkIntervals.clear();
        this.monitors.clear();
        this.parsedData.clear();
        this.requiresBrowser.clear();
        this.inFlightChecks.clear();
        this.backoffUntil.clear();
        this.softErrorStreak.clear();

        // Close browser client if active
        try {
            await closeBrowserClient();
            logger.debug('Browser client closed');
        } catch (error) {
            logger.error('Error closing browser client', { error: error.message });
        }

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
        
        const monitorType = monitor.monitorType || 'auto';
        logger.debug(`Scheduled monitor ${monitor.id} (${monitor.name}) - type: ${monitorType}, every ${monitor.checkInterval}s`);
    }

    /**
     * Check a page for changes using site-specific parsers
     */
    async checkPage(monitorId) {
        const monitor = this.monitors.get(monitorId);
        if (!monitor || !this.isRunning) return;
        if (monitor.isActive === false) return;

        if (this.inFlightChecks.has(monitorId)) {
            logger.debug(`Skipping monitor ${monitorId} check (already in progress)`);
            return;
        }

        const backoffUntil = this.backoffUntil.get(monitorId);
        if (backoffUntil && Date.now() < backoffUntil) {
            logger.debug(`Skipping monitor ${monitorId} check (backoff active)`, {
                backoffUntil: new Date(backoffUntil).toISOString(),
            });
            return;
        }

        this.inFlightChecks.add(monitorId);

        try {
            // Determine monitor type (auto-detect if not specified)
            const monitorType = monitor.monitorType || 'auto';
            const keywords = monitor.keywords ? monitor.keywords.split(',').map(k => k.trim()) : [];

            // Check if this monitor requires browser-based fetching
            const forceBrowser = this.requiresBrowser.has(monitorId);

            // Parse the site using appropriate parser
            const parsedData = await parseSite(monitor.url, {
                type: monitorType === 'auto' ? null : monitorType,
                keywords,
                forceBrowser,
            });

            if (!parsedData.success) {
                throw new Error(parsedData.error || 'Failed to parse page');
            }

            // Track if browser was needed (for future checks)
            if (parsedData._usedBrowser && !forceBrowser) {
                this.requiresBrowser.add(monitorId);
                await this.updateBrowserRequirement(monitorId, true, parsedData._browserReason);
                logger.info(`Monitor ${monitorId} now requires browser`, {
                    reason: parsedData._browserReason,
                    url: monitor.url,
                });
            }

            // Get previous parsed data
            const previousData = this.parsedData.get(monitorId);
            const isFirstCheck = !previousData;

            // Detect changes
            const changeResult = detectChanges(previousData, parsedData);
            
            // Legacy hash comparison for generic fallback
            const contentHash = crypto.createHash('md5').update(parsedData._hash || '').digest('hex');
            const hashChanged = monitor.lastHash && monitor.lastHash !== contentHash;

            // Determine if we should alert
            let shouldAlert = false;
            let alertChanges = [];

            if (!isFirstCheck) {
                if (changeResult.hasChanges) {
                    // Filter changes based on alert settings
                    alertChanges = this.filterAlertableChanges(monitor, changeResult.changes);
                    shouldAlert = alertChanges.length > 0;
                } else if (hashChanged && monitor.alertOnAnyChange) {
                    // Fallback: alert on any hash change if enabled
                    shouldAlert = true;
                    alertChanges = [{ type: 'content', message: 'Page content has changed' }];
                }
            }

            // Update database
            const parsedDataJson = JSON.stringify(parsedData);
            await db.pool.query(
                `UPDATE PageMonitors 
                 SET lastHash = ?, lastChecked = NOW(), errorCount = 0, lastError = NULL,
                     lastParsedData = ?, detectedType = ?
                 ${changeResult.hasChanges || hashChanged ? ', lastChanged = NOW()' : ''}
                 WHERE id = ?`,
                [contentHash, parsedDataJson, parsedData.type, monitorId]
            );

            // Update local cache
            monitor.lastHash = contentHash;
            monitor.lastChecked = new Date();
            monitor.errorCount = 0;
            monitor.detectedType = parsedData.type;
            this.parsedData.set(monitorId, parsedData);
            this.backoffUntil.delete(monitorId);
            this.softErrorStreak.delete(monitorId);

            if (changeResult.hasChanges || hashChanged) {
                monitor.lastChanged = new Date();
            }

            // Send alert if needed
            if (shouldAlert) {
                await this.sendSmartAlert(monitor, parsedData, alertChanges);
            }

            logger.debug(`Checked monitor ${monitorId} (${monitor.name})`, {
                type: parsedData.type,
                hasChanges: changeResult.hasChanges,
                changeCount: changeResult.changes?.length || 0,
                alerted: shouldAlert,
            });

        } catch (error) {
            const message = error?.message || String(error);
            const isSoftError = /queue-it/i.test(message);

            if (isSoftError) {
                const streak = (this.softErrorStreak.get(monitorId) || 0) + 1;
                this.softErrorStreak.set(monitorId, streak);

                const delayMs = Math.min(this.softBackoffBaseMs * Math.pow(2, streak - 1), this.softBackoffMaxMs);
                const until = Date.now() + delayMs;
                this.backoffUntil.set(monitorId, until);

                await db.pool.query(
                    'UPDATE PageMonitors SET lastChecked = NOW(), errorCount = 0, lastError = ? WHERE id = ?',
                    [message, monitorId]
                );

                monitor.errorCount = 0;
                monitor.lastError = message;
                monitor.lastChecked = new Date();

                logger.warn(`Monitor ${monitorId} (${monitor.name}) blocked (soft error)`, {
                    error: message,
                    softErrorStreak: streak,
                    backoffSeconds: Math.round(delayMs / 1000),
                });

                return;
            }

            const errorCount = (monitor.errorCount || 0) + 1;

            await db.pool.query(
                'UPDATE PageMonitors SET lastChecked = NOW(), errorCount = ?, lastError = ? WHERE id = ?',
                [errorCount, message, monitorId]
            );

            monitor.errorCount = errorCount;
            monitor.lastError = message;
            monitor.lastChecked = new Date();

            logger.warn(`Monitor ${monitorId} (${monitor.name}) error`, {
                error: message,
                errorCount
            });

            // Pause monitor if too many errors
            if (errorCount >= this.maxErrors) {
                await this.pauseMonitor(monitorId, 'Too many consecutive errors');
            }
        } finally {
            this.inFlightChecks.delete(monitorId);
        }
    }

    /**
     * Filter changes based on monitor alert settings
     */
    filterAlertableChanges(monitor, changes) {
        if (!changes || !changes.length) return [];

        // Get alert settings (default: alert on everything)
        let settings = {};
        if (monitor.alertSettings) {
            try {
                settings = JSON.parse(monitor.alertSettings);
            } catch {}
        }
        
        const {
            alertOnStock = true,
            alertOnPrice = true,
            alertOnAvailability = true,
            alertOnKeywords = true,
            alertOnNewVariants = true,
            alertOnTickets = true,
            alertOnPresale = true,
        } = settings;

        const ignoreBlockHashPrefixes = Array.isArray(settings.ignoreBlockHashPrefixes) ? settings.ignoreBlockHashPrefixes : [];
        const ignorePatterns = Array.isArray(settings.ignorePatterns) ? settings.ignorePatterns : [];
        const compiledIgnoreRegexes = ignorePatterns.map(p => {
            try {
                return new RegExp(p, 'i');
            } catch {
                return null;
            }
        }).filter(Boolean);

        const isIgnored = (change) => {
            if (change?.blockHash && ignoreBlockHashPrefixes.some(p => change.blockHash.startsWith(p))) {
                return true;
            }

            const haystacks = [
                change?.message,
                change?.snippet,
                change?.keyword,
            ].filter(Boolean);

            if (haystacks.length === 0 || compiledIgnoreRegexes.length === 0) return false;

            return compiledIgnoreRegexes.some(rx => haystacks.some(h => rx.test(String(h))));
        };

        return changes.filter(change => {
            if (isIgnored(change)) return false;

            switch (change.type) {
                case 'stock':
                case 'variant_restock':
                case 'variant_oos':
                    return alertOnStock;
                case 'price':
                    return alertOnPrice;
                case 'availability':
                case 'tickets_available':
                case 'sold_out':
                case 'on_sale':
                    return alertOnAvailability || alertOnTickets;
                case 'presale':
                    return alertOnPresale;
                case 'keyword_appeared':
                    return alertOnKeywords;
                case 'new_variant':
                    return alertOnNewVariants;
                default:
                    return true;
            }
        });
    }

    /**
     * Send a smart alert with detailed change information
     */
    async sendSmartAlert(monitor, parsedData, changes) {
        try {
            const channel = await this.client.channels.fetch(monitor.channelId);
            if (!channel) {
                logger.warn(`Channel ${monitor.channelId} not found for monitor ${monitor.id}`);
                return;
            }

            // Build embed based on site type
            const embed = this.buildAlertEmbed(monitor, parsedData, changes);

            // Build message content with optional role ping
            let messageContent = '';
            if (monitor.roleToMention) {
                messageContent = `<@&${monitor.roleToMention}>`;
            }

            // Add urgency indicator for high-priority changes
            const urgentChanges = changes.filter(c => 
                ['tickets_available', 'on_sale', 'variant_restock', 'availability'].includes(c.type) &&
                (c.new === true || parsedData.available)
            );
            
            if (urgentChanges.length > 0) {
                messageContent = `🚨 ${messageContent}`.trim();
            }

            await channel.send({
                content: messageContent || undefined,
                embeds: [embed],
            });

            logger.info(`Smart alert sent for monitor ${monitor.id} (${monitor.name})`, {
                type: parsedData.type,
                changeCount: changes.length,
            });

        } catch (error) {
            logger.error(`Failed to send alert for monitor ${monitor.id}`, { error: error.message });
        }
    }

    /**
     * Build an alert embed based on site type and changes
     */
    buildAlertEmbed(monitor, parsedData, changes) {
        const embed = new EmbedBuilder()
            .setTimestamp()
            .setFooter({ text: 'The Pack • Page Monitor', iconURL: this.client.logo });

        // Set color based on change type
        const hasPositiveChange = changes.some(c => 
            ['tickets_available', 'on_sale', 'variant_restock', 'presale'].includes(c.type) ||
            (c.type === 'availability' && c.new === true)
        );
        const hasPriceDropChange = changes.some(c => c.type === 'price' && c.new < c.old);
        
        if (hasPositiveChange) {
            embed.setColor('#00ff00'); // Green for good news
        } else if (hasPriceDropChange) {
            embed.setColor('#00aaff'); // Blue for price drop
        } else {
            embed.setColor('#ffaa00'); // Orange for other changes
        }

        // Site-specific embed formatting
        switch (parsedData.type) {
            case 'shopify':
                return this.buildShopifyEmbed(embed, monitor, parsedData, changes);
            case 'ticketmaster':
            case 'ticketek':
            case 'axs':
            case 'eventbrite':
                return this.buildTicketEmbed(embed, monitor, parsedData, changes);
            default:
                return this.buildGenericEmbed(embed, monitor, parsedData, changes);
        }
    }

    /**
     * Build Shopify-specific embed
     */
    buildShopifyEmbed(embed, monitor, data, changes) {
        // Determine the main alert message
        const restockChanges = changes.filter(c => c.type === 'variant_restock' || (c.type === 'availability' && c.new));
        const priceChanges = changes.filter(c => c.type === 'price');
        
        let title = '🔔 Product Update';
        if (restockChanges.length > 0) {
            title = '🟢 BACK IN STOCK!';
        } else if (priceChanges.length > 0 && priceChanges[0].new < priceChanges[0].old) {
            title = '📉 PRICE DROP!';
        }

        embed.setTitle(title)
            .setDescription(`**${monitor.name}**\n${data.title || ''}`)
            .setURL(monitor.url);

        if (data.image) {
            embed.setThumbnail(data.image);
        }

        // Add change details
        const changeMessages = changes.map(c => c.message).slice(0, 5);
        if (changeMessages.length > 0) {
            embed.addFields({
                name: '📋 Changes',
                value: changeMessages.join('\n'),
            });
        }

        // Add stock info
        if (data.totalStock !== undefined) {
            embed.addFields({
                name: 'Total Stock',
                value: data.totalStock.toString(),
                inline: true,
            });
        }

        // Add price info
        if (data.priceRange) {
            const priceStr = data.priceRange.min === data.priceRange.max 
                ? `$${data.priceRange.min}`
                : `$${data.priceRange.min} - $${data.priceRange.max}`;
            embed.addFields({
                name: 'Price',
                value: priceStr,
                inline: true,
            });
        }

        // Add availability
        embed.addFields({
            name: 'Status',
            value: data.available ? '✅ Available' : '❌ Sold Out',
            inline: true,
        });

        return embed;
    }

    /**
     * Build ticket-specific embed
     */
    buildTicketEmbed(embed, monitor, data, changes) {
        // Determine the main alert message
        const ticketChanges = changes.filter(c => 
            ['tickets_available', 'on_sale', 'presale'].includes(c.type)
        );
        
        let title = '🎟️ Event Update';
        let emoji = '🔔';
        
        if (ticketChanges.some(c => c.type === 'tickets_available' || c.type === 'on_sale')) {
            title = 'TICKETS AVAILABLE!';
            emoji = '🎉';
        } else if (ticketChanges.some(c => c.type === 'presale')) {
            title = 'PRESALE NOW LIVE!';
            emoji = '⭐';
        } else if (changes.some(c => c.type === 'sold_out')) {
            title = 'SOLD OUT';
            emoji = '❌';
        }

        embed.setTitle(`${emoji} ${title}`)
            .setDescription(`**${monitor.name}**\n${data.title || ''}`)
            .setURL(monitor.url);

        if (data.image) {
            embed.setThumbnail(data.image);
        }

        // Add event details
        if (data.venue) {
            embed.addFields({ name: 'Venue', value: data.venue, inline: true });
        }
        if (data.date) {
            embed.addFields({ name: 'Date', value: data.date, inline: true });
        }

        // Add status
        const statusParts = [];
        if (data.status?.onSale) statusParts.push('✅ On Sale');
        if (data.status?.presale) statusParts.push('⭐ Presale Active');
        if (data.status?.soldOut) statusParts.push('❌ Sold Out');
        if (data.status?.waitlist) statusParts.push('📝 Waitlist Available');
        
        if (statusParts.length > 0) {
            embed.addFields({ name: 'Status', value: statusParts.join(' • '), inline: false });
        }

        // Add price if available
        if (data.priceRange) {
            embed.addFields({ name: 'Price', value: data.priceRange, inline: true });
        }

        // Add change details
        const changeMessages = changes.map(c => c.message).slice(0, 3);
        if (changeMessages.length > 0) {
            embed.addFields({
                name: '📋 What Changed',
                value: changeMessages.join('\n'),
            });
        }

        return embed;
    }

    /**
     * Build generic page embed
     */
    buildGenericEmbed(embed, monitor, data, changes) {
        embed.setTitle('🔔 Page Change Detected!')
            .setDescription(`**${monitor.name}** has changed!`)
            .setURL(monitor.url);

        // Add page title
        if (data.title) {
            embed.addFields({ name: 'Page Title', value: data.title.slice(0, 256), inline: false });
        }

        // Add change details
        const changeMessages = changes.map(c => c.message).slice(0, 5);
        if (changeMessages.length > 0) {
            embed.addFields({
                name: '📋 Changes',
                value: changeMessages.join('\n'),
            });
        }

        // Add keyword matches if any
        if (data.keywordMatches) {
            const foundKeywords = Object.entries(data.keywordMatches)
                .filter(([, found]) => found)
                .map(([kw]) => `\`${kw}\``);
            
            if (foundKeywords.length > 0) {
                embed.addFields({
                    name: '🔑 Keywords Found',
                    value: foundKeywords.join(', '),
                    inline: true,
                });
            }
        }

        // Add detected prices
        if (data.prices && data.prices.length > 0) {
            embed.addFields({
                name: '💰 Prices Detected',
                value: data.prices.join(', '),
                inline: true,
            });
        }

        embed.addFields({
            name: 'Detected At',
            value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
            inline: true,
        });

        return embed;
    }

    /**
     * Add a new monitor
     */
    async addMonitor(data) {
        // Auto-detect site type if not specified
        const detectedType = data.monitorType === 'auto' || !data.monitorType
            ? detectSiteType(data.url)
            : data.monitorType;

        const [result] = await db.pool.query(
            `INSERT INTO PageMonitors (guildId, channelId, createdBy, name, url, keywords, checkInterval, roleToMention, monitorType, alertSettings, alertOnAnyChange)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                data.guildId,
                data.channelId,
                data.createdBy,
                data.name,
                data.url,
                data.keywords || null,
                data.checkInterval || 60,
                data.roleToMention || null,
                data.monitorType || 'auto',
                data.alertSettings ? JSON.stringify(data.alertSettings) : null,
                data.alertOnAnyChange ? 1 : 0,
            ]
        );

        const [rows] = await db.pool.query('SELECT * FROM PageMonitors WHERE id = ?', [result.insertId]);
        const monitor = rows[0];
        monitor.detectedType = detectedType;

        this.scheduleMonitor(monitor);

        logger.info(`Added new monitor: ${data.name}`, { 
            id: result.insertId,
            url: data.url,
            type: data.monitorType || 'auto',
            detectedType,
            guild: data.guildId,
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
        this.parsedData.delete(monitorId);

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
        
        // Reload cached parsed data
        if (monitor.lastParsedData) {
            try {
                this.parsedData.set(monitorId, JSON.parse(monitor.lastParsedData));
            } catch {}
        }

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
        const allowedFields = ['name', 'url', 'keywords', 'checkInterval', 'roleToMention', 'channelId', 'monitorType', 'alertSettings', 'alertOnAnyChange'];
        const setClauses = [];
        const values = [];

        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key)) {
                setClauses.push(`${key} = ?`);
                if (key === 'alertSettings' && typeof value === 'object') {
                    values.push(JSON.stringify(value));
                } else {
                    values.push(value);
                }
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

    /**
     * Test fetch a monitor (manual check)
     */
    async testMonitor(monitorId, guildId) {
        const [rows] = await db.pool.query(
            'SELECT * FROM PageMonitors WHERE id = ? AND guildId = ?',
            [monitorId, guildId]
        );

        if (rows.length === 0) {
            return { success: false, error: 'Monitor not found' };
        }

        const monitor = rows[0];

        try {
            const monitorType = monitor.monitorType || 'auto';
            const keywords = monitor.keywords ? monitor.keywords.split(',').map(k => k.trim()) : [];
            const forceBrowser = this.requiresBrowser.has(monitorId) || !!monitor.requiresBrowser;
            
            const parsedData = await parseSite(monitor.url, {
                type: monitorType === 'auto' ? null : monitorType,
                keywords,
                forceBrowser,
            });

            // Track if browser was needed (for future checks)
            if (parsedData._usedBrowser && !forceBrowser) {
                this.requiresBrowser.add(monitorId);
                await this.updateBrowserRequirement(monitorId, true, parsedData._browserReason);
                logger.info(`Monitor ${monitorId} now requires browser`, {
                    reason: parsedData._browserReason,
                    url: monitor.url,
                });
            }

            return {
                success: true,
                data: parsedData,
                detectedType: parsedData.type,
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
            };
        }
    }

    /**
     * Get supported site types
     */
    getSupportedTypes() {
        return getSupportedSiteTypes();
    }

    /**
     * Update browser requirement for a monitor
     */
    async updateBrowserRequirement(monitorId, requiresBrowser, reason = null) {
        await db.pool.query(
            'UPDATE PageMonitors SET requiresBrowser = ?, lastBrowserReason = ? WHERE id = ?',
            [requiresBrowser ? 1 : 0, reason, monitorId]
        );

        const monitor = this.monitors.get(monitorId);
        if (monitor) {
            monitor.requiresBrowser = requiresBrowser;
            monitor.lastBrowserReason = reason;
        }
    }
}

module.exports = PageMonitorService;
