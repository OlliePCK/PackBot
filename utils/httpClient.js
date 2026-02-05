/**
 * Shared HTTP client utility with user-agent rotation, proxy support, retries, and rate limiting
 */

const logger = require('../logger').child('http-client');
const { detectQueueItFromRedirect, detectQueueItFromHtml } = require('./queueitDetector');

// User agents to rotate through (desktop and mobile)
const USER_AGENTS = {
    desktop: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0 Safari/537.36',
    ],
    mobile: [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    ]
};

// Rate limiting state per domain
const rateLimitState = new Map();
const DEFAULT_MIN_DELAY = 1000; // 1 second between requests to same domain

/**
 * Get a random user agent
 * @param {'desktop'|'mobile'|'random'} type - Type of user agent
 * @returns {string}
 */
function getRandomUserAgent(type = 'desktop') {
    if (type === 'random') {
        type = Math.random() > 0.8 ? 'mobile' : 'desktop';
    }
    const agents = USER_AGENTS[type] || USER_AGENTS.desktop;
    return agents[Math.floor(Math.random() * agents.length)];
}

/**
 * Sleep for a specified time
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get domain from URL for rate limiting
 * @param {string} url 
 * @returns {string}
 */
function getDomain(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

/**
 * Apply rate limiting for a domain
 * @param {string} domain 
 * @param {number} minDelay 
 */
async function applyRateLimit(domain, minDelay = DEFAULT_MIN_DELAY) {
    const now = Date.now();
    const lastRequest = rateLimitState.get(domain) || 0;
    const timeSince = now - lastRequest;
    
    if (timeSince < minDelay) {
        await sleep(minDelay - timeSince);
    }
    
    rateLimitState.set(domain, Date.now());
}

/**
 * Enhanced HTTP client with retry support
 */
class HttpClient {
    constructor(options = {}) {
        this.defaultTimeout = options.timeout || 15000;
        this.defaultRetries = options.retries || 3;
        this.defaultRetryDelay = options.retryDelay || 1000;
        this.proxyUrl = options.proxyUrl || process.env.PROXY_URL;
        this.userAgentType = options.userAgentType || 'desktop';
        this.rateLimit = options.rateLimit ?? true;
        this.minRequestDelay = options.minRequestDelay || DEFAULT_MIN_DELAY;
    }

    /**
     * Make an HTTP request with retries and error handling
     * @param {string} url - URL to fetch
     * @param {object} options - Fetch options
     * @returns {Promise<{ok: boolean, status: number, data: any, text: string, headers: Headers, requiresBrowser: boolean, queueItDetected: boolean}>}
     */
    async request(url, options = {}) {
        const {
            method = 'GET',
            headers = {},
            body,
            timeout = this.defaultTimeout,
            retries = this.defaultRetries,
            retryDelay = this.defaultRetryDelay,
            userAgent = getRandomUserAgent(this.userAgentType),
            parseJson = false,
            rateLimit = this.rateLimit,
            followRedirects = true,
            detectQueueIt = true,
        } = options;

        // Apply rate limiting
        if (rateLimit) {
            const domain = getDomain(url);
            await applyRateLimit(domain, this.minRequestDelay);
        }

        const defaultHeaders = {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            ...headers,
        };

        let lastError;
        
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeout);

                const fetchOptions = {
                    method,
                    headers: defaultHeaders,
                    signal: controller.signal,
                    redirect: detectQueueIt ? 'manual' : (followRedirects ? 'follow' : 'manual'),
                };

                if (body) {
                    fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
                    if (!headers['Content-Type']) {
                        fetchOptions.headers['Content-Type'] = 'application/json';
                    }
                }

                // Add proxy support if configured
                if (this.proxyUrl) {
                    // Note: Native fetch doesn't support proxies directly
                    // You'd need to use a library like 'https-proxy-agent' with node-fetch
                    // For now, this is a placeholder
                }

                const response = await fetch(url, fetchOptions);
                clearTimeout(timeoutId);

                // Check for Queue-it redirect (3xx with location header)
                if (detectQueueIt && response.status >= 300 && response.status < 400) {
                    const location = response.headers.get('location');
                    const queueItResult = detectQueueItFromRedirect(location);

                    if (queueItResult.detected) {
                        logger.info('Queue-it detected from redirect', { url, redirectUrl: location });
                        return {
                            ok: false,
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers,
                            text: '',
                            data: null,
                            requiresBrowser: true,
                            queueItDetected: true,
                            queueItReason: queueItResult.reason,
                            redirectUrl: location,
                        };
                    }

                    // Not Queue-it, follow the redirect manually if needed
                    if (followRedirects && location) {
                        const absoluteUrl = new URL(location, url).href;
                        return this.request(absoluteUrl, { ...options, detectQueueIt: false });
                    }
                }

                const text = await response.text();
                let data = text;

                if (parseJson || response.headers.get('content-type')?.includes('application/json')) {
                    try {
                        data = JSON.parse(text);
                    } catch {
                        // Keep as text if JSON parse fails
                    }
                }

                // Check HTML content for Queue-it patterns
                let queueItDetected = false;
                let requiresBrowser = false;
                let queueItReason = null;

                if (detectQueueIt && response.ok && text) {
                    const htmlResult = detectQueueItFromHtml(text);
                    if (htmlResult.detected && htmlResult.inWaitingRoom) {
                        logger.info('Queue-it detected in HTML content', { url, reason: htmlResult.reason });
                        queueItDetected = true;
                        requiresBrowser = true;
                        queueItReason = htmlResult.reason;
                    }
                }

                return {
                    ok: response.ok,
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                    text,
                    data,
                    requiresBrowser,
                    queueItDetected,
                    queueItReason,
                };

            } catch (error) {
                lastError = error;
                
                const isRetryable =
                    error.name === 'AbortError' ||
                    error.code === 'ECONNRESET' ||
                    error.code === 'ETIMEDOUT' ||
                    error.code === 'ENOTFOUND' ||
                    error.code === 'ECONNREFUSED' ||
                    error.code === 'EPIPE' ||
                    error.code === 'UND_ERR_SOCKET' ||
                    error.code === 'UND_ERR_CONNECT_TIMEOUT' ||
                    error.code === 'UND_ERR_HEADERS_TIMEOUT' ||
                    error.code === 'UND_ERR_BODY_TIMEOUT' ||
                    error.code === 'UND_ERR_ABORTED';

                if (attempt < retries && isRetryable) {
                    const delay = retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
                    logger.debug(`Request failed, retrying in ${delay}ms`, { 
                        url, 
                        attempt, 
                        error: error.message 
                    });
                    await sleep(delay);
                } else {
                    break;
                }
            }
        }

        throw lastError;
    }

    /**
     * GET request helper
     */
    async get(url, options = {}) {
        return this.request(url, { ...options, method: 'GET' });
    }

    /**
     * POST request helper
     */
    async post(url, body, options = {}) {
        return this.request(url, { ...options, method: 'POST', body });
    }

    /**
     * Fetch and return just the text content
     */
    async getText(url, options = {}) {
        const response = await this.get(url, options);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response.text;
    }

    /**
     * Fetch and return parsed JSON
     */
    async getJson(url, options = {}) {
        const response = await this.get(url, { ...options, parseJson: true });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response.data;
    }
}

// Default client instance
const defaultClient = new HttpClient();

module.exports = {
    HttpClient,
    defaultClient,
    getRandomUserAgent,
    USER_AGENTS,
    sleep,
    applyRateLimit,
    getDomain,
};
