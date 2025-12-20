/**
 * Queue-it Detection Utilities
 * Detects Queue-it virtual waiting room protection on websites
 */

const logger = require('../logger').child('queueit-detector');

// Queue-it domain patterns
const QUEUE_IT_DOMAINS = [
    'queue-it.net',
    'queue-it.com',
];

// Patterns to detect Queue-it in HTML content
const QUEUE_IT_HTML_PATTERNS = [
    /queue-it\.net/i,
    /queue-it\.com/i,
    /queueit/i,
    /QueueITUrl/i,
    /QueueIT\.Queue/i,
    /data-queueit/i,
    /knownuser/i,
];

// Patterns that indicate you're currently in a Queue-it waiting room
const QUEUE_IT_WAITING_PATTERNS = [
    /you\s*are\s*now\s*in\s*line/i,
    /waiting\s*room/i,
    /queue\s*position/i,
    /your\s*estimated\s*wait/i,
    /please\s*wait/i,
];

/**
 * Check if a URL is a Queue-it domain
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function isQueueItUrl(url) {
    if (!url) return false;

    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return QUEUE_IT_DOMAINS.some(domain => hostname.includes(domain));
    } catch {
        return false;
    }
}

/**
 * Check if a redirect URL indicates Queue-it protection
 * @param {string} redirectUrl - The redirect location URL
 * @returns {{detected: boolean, reason: string}}
 */
function detectQueueItFromRedirect(redirectUrl) {
    if (!redirectUrl) {
        return { detected: false, reason: null };
    }

    if (isQueueItUrl(redirectUrl)) {
        logger.debug('Queue-it detected from redirect', { redirectUrl });
        return {
            detected: true,
            reason: 'redirect-to-queue-it',
            redirectUrl
        };
    }

    return { detected: false, reason: null };
}

/**
 * Check HTML content for Queue-it scripts or patterns
 * @param {string} html - HTML content to check
 * @returns {{detected: boolean, reason: string, inWaitingRoom: boolean}}
 */
function detectQueueItFromHtml(html) {
    if (!html || typeof html !== 'string') {
        return { detected: false, reason: null, inWaitingRoom: false };
    }

    // Check for Queue-it scripts/patterns
    for (const pattern of QUEUE_IT_HTML_PATTERNS) {
        if (pattern.test(html)) {
            logger.debug('Queue-it detected in HTML', { pattern: pattern.toString() });

            // Also check if we're in the waiting room
            const inWaitingRoom = QUEUE_IT_WAITING_PATTERNS.some(p => p.test(html));

            return {
                detected: true,
                reason: 'html-pattern-match',
                inWaitingRoom
            };
        }
    }

    return { detected: false, reason: null, inWaitingRoom: false };
}

/**
 * Combined detection - checks both redirect and HTML
 * @param {object} options
 * @param {string} options.redirectUrl - Redirect URL if any
 * @param {string} options.html - HTML content if available
 * @returns {{detected: boolean, reason: string, inWaitingRoom: boolean, redirectUrl: string}}
 */
function detectQueueIt({ redirectUrl, html }) {
    // Check redirect first (most reliable)
    const redirectResult = detectQueueItFromRedirect(redirectUrl);
    if (redirectResult.detected) {
        return {
            ...redirectResult,
            inWaitingRoom: true
        };
    }

    // Check HTML content
    if (html) {
        const htmlResult = detectQueueItFromHtml(html);
        if (htmlResult.detected) {
            return htmlResult;
        }
    }

    return { detected: false, reason: null, inWaitingRoom: false };
}

module.exports = {
    isQueueItUrl,
    detectQueueItFromRedirect,
    detectQueueItFromHtml,
    detectQueueIt,
    QUEUE_IT_DOMAINS,
};
