// scripts/cookie-monitor.js - Monitor YouTube cookie expiration and alert
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { EmbedBuilder } = require('discord.js');
const logger = require('../logger').child('cookie-monitor');

// Configuration
const ALERT_CHANNEL_ID = '255258298230636545'; // The Pack general channel
const DAYS_BEFORE_EXPIRY_WARNING = 30; // Alert when cookies expire within 30 days
const DAYS_BEFORE_EXPIRY_CRITICAL = 7; // Critical alert when within 7 days

module.exports = (client) => {
    // Check cookies daily at 9 AM
    cron.schedule('0 9 * * *', () => {
        checkCookieExpiration(client).catch(err => {
            logger.error('Cookie check failed:', err.message);
        });
    });

    // Also check on startup (after a delay to ensure client is ready)
    setTimeout(() => {
        checkCookieExpiration(client).catch(err => {
            logger.error('Startup cookie check failed:', err.message);
        });
    }, 10000);

    logger.info('Cookie expiration monitor initialized');
};

async function checkCookieExpiration(client) {
    const cookiePath = process.env.YTDLP_COOKIES_PATH ||
                       process.env.YTDLP_COOKIES_FILE ||
                       process.env.YTDLP_COOKIES ||
                       '/usr/src/app/cookies.txt';

    if (!fs.existsSync(cookiePath)) {
        logger.warn('Cookie file not found:', cookiePath);
        return;
    }

    const content = fs.readFileSync(cookiePath, 'utf8');
    const lines = content.split('\n');

    const now = Math.floor(Date.now() / 1000);
    const criticalThreshold = now + (DAYS_BEFORE_EXPIRY_CRITICAL * 24 * 60 * 60);
    const warningThreshold = now + (DAYS_BEFORE_EXPIRY_WARNING * 24 * 60 * 60);

    // Track important YouTube auth cookies
    const authCookies = [
        '__Secure-1PSID',
        '__Secure-3PSID',
        '__Secure-1PAPISID',
        '__Secure-3PAPISID',
        'SID',
        'SSID',
        'HSID'
    ];

    const expiringCookies = [];
    const expiredCookies = [];

    for (const line of lines) {
        if (line.startsWith('#') || !line.trim()) continue;

        const parts = line.split('\t');
        if (parts.length < 7) continue;

        const [domain, , , , expiresStr, name] = parts;

        // Only check YouTube cookies
        if (!domain.includes('youtube.com') && !domain.includes('.google.com')) continue;

        // Focus on auth cookies
        const isAuthCookie = authCookies.some(ac => name.includes(ac));
        if (!isAuthCookie) continue;

        const expires = parseInt(expiresStr, 10);
        if (!expires || expires === 0) continue; // Session cookies, skip

        const daysLeft = Math.floor((expires - now) / (24 * 60 * 60));

        if (expires < now) {
            expiredCookies.push({ name, domain, daysLeft: daysLeft });
        } else if (expires < criticalThreshold) {
            expiringCookies.push({ name, domain, daysLeft, level: 'critical' });
        } else if (expires < warningThreshold) {
            expiringCookies.push({ name, domain, daysLeft, level: 'warning' });
        }
    }

    // Send alerts if needed
    if (expiredCookies.length > 0 || expiringCookies.length > 0) {
        await sendCookieAlert(client, expiredCookies, expiringCookies);
    } else {
        logger.info('All YouTube cookies are healthy');
    }
}

async function sendCookieAlert(client, expiredCookies, expiringCookies) {
    const channel = await client.channels.fetch(ALERT_CHANNEL_ID).catch(() => null);
    if (!channel) {
        logger.error('Could not fetch alert channel:', ALERT_CHANNEL_ID);
        return;
    }

    const hasCritical = expiringCookies.some(c => c.level === 'critical') || expiredCookies.length > 0;

    const embed = new EmbedBuilder()
        .setTitle(hasCritical ? '🚨 YouTube Cookie Alert' : '⚠️ YouTube Cookie Warning')
        .setColor(hasCritical ? '#ff0000' : '#ffaa00')
        .setTimestamp()
        .setFooter({ text: 'PackBot Cookie Monitor' });

    if (expiredCookies.length > 0) {
        embed.addFields({
            name: '❌ Expired Cookies',
            value: expiredCookies.map(c => `\`${c.name}\` (expired ${Math.abs(c.daysLeft)} days ago)`).join('\n'),
            inline: false
        });
    }

    const criticalCookies = expiringCookies.filter(c => c.level === 'critical');
    if (criticalCookies.length > 0) {
        embed.addFields({
            name: '🔴 Critical - Expiring Soon',
            value: criticalCookies.map(c => `\`${c.name}\` (${c.daysLeft} days left)`).join('\n'),
            inline: false
        });
    }

    const warningCookies = expiringCookies.filter(c => c.level === 'warning');
    if (warningCookies.length > 0) {
        embed.addFields({
            name: '🟡 Warning - Expiring Within 30 Days',
            value: warningCookies.map(c => `\`${c.name}\` (${c.daysLeft} days left)`).join('\n'),
            inline: false
        });
    }

    embed.addFields({
        name: '📋 How to Refresh',
        value: '1. On your PC, run:\n```yt-dlp --cookies-from-browser chrome --cookies cookies.txt -s "https://youtube.com"```\n2. Upload `cookies.txt` to server\n3. Restart PackBot',
        inline: false
    });

    await channel.send({
        content: hasCritical ? '<@&255258298230636545>' : '', // Ping if critical (adjust role ID if needed)
        embeds: [embed]
    });

    logger.info(`Sent cookie ${hasCritical ? 'critical' : 'warning'} alert`);
}

// Export for manual checking
module.exports.checkCookieExpiration = checkCookieExpiration;
