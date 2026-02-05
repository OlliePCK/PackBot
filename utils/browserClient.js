/**
 * Puppeteer Browser Client
 * Manages headless browser instances for pages that require JavaScript execution
 * (e.g., Queue-it protected sites)
 */

const puppeteer = require('puppeteer');
const logger = require('../logger').child('browser-client');
const { getRandomUserAgent } = require('./httpClient');
const { isQueueItUrl } = require('./queueitDetector');

// Default configuration
const DEFAULT_CONFIG = {
    navigationTimeout: 60000,      // 60 seconds for page load
    queueWaitTimeout: 120000,      // 2 minutes max wait in Queue-it
    queueCheckInterval: 5000,      // Check queue status every 5 seconds
    maxPagesBeforeRestart: 100,    // Restart browser after N pages (memory management)
    viewportWidth: 1920,
    viewportHeight: 1080,
    // Proxy support (uses PROXY_URL env var if set)
    useProxy: !!process.env.PROXY_URL,
    proxyUrl: process.env.PROXY_URL,
};

/**
 * Simple async mutex for preventing race conditions
 */
class AsyncMutex {
    constructor() {
        this.locked = false;
        this.waitQueue = [];
    }

    async acquire() {
        if (!this.locked) {
            this.locked = true;
            return;
        }

        // Wait for unlock
        return new Promise(resolve => {
            this.waitQueue.push(resolve);
        });
    }

    release() {
        if (this.waitQueue.length > 0) {
            const next = this.waitQueue.shift();
            next();
        } else {
            this.locked = false;
        }
    }
}

/**
 * Browser client for headless browser operations
 */
class BrowserClient {
    constructor(options = {}) {
        this.config = { ...DEFAULT_CONFIG, ...options };
        this.browser = null;
        this.pageCount = 0;
        this.activePages = 0;          // Track active pages in use
        this.isLaunching = false;
        this.launchPromise = null;
        this.mutex = new AsyncMutex(); // Prevent race conditions
    }

    /**
     * Ensure browser is launched (lazy initialization)
     * @returns {Promise<Browser>}
     */
    async ensureBrowser() {
        await this.mutex.acquire();

        try {
            // If browser exists and is connected, check if we need to restart
            if (this.browser && this.browser.connected) {
                // Only restart if no active pages AND we've exceeded the limit
                if (this.pageCount >= this.config.maxPagesBeforeRestart && this.activePages === 0) {
                    logger.info('Restarting browser due to page count limit', {
                        pageCount: this.pageCount,
                        activePages: this.activePages
                    });
                    await this._closeBrowserInternal();
                } else {
                    return this.browser;
                }
            }

            // If already launching, wait for that promise
            if (this.isLaunching && this.launchPromise) {
                this.mutex.release();
                return this.launchPromise;
            }

            // Launch new browser
            this.isLaunching = true;
            this.launchPromise = this._launchBrowser();

            try {
                this.browser = await this.launchPromise;
                this.pageCount = 0;
                logger.info('Browser launched successfully');
                return this.browser;
            } finally {
                this.isLaunching = false;
                this.launchPromise = null;
            }
        } finally {
            this.mutex.release();
        }
    }

    /**
     * Track when a page is opened (call before using a page)
     */
    trackPageOpen() {
        this.activePages++;
    }

    /**
     * Track when a page is closed (call after closing a page)
     */
    trackPageClose() {
        this.activePages = Math.max(0, this.activePages - 1);
        this.pageCount++;
    }

    /**
     * Parse proxy URL into components
     * @returns {{host: string, port: string, username: string, password: string}|null}
     */
    parseProxyUrl() {
        if (!this.config.proxyUrl) return null;

        try {
            const url = new URL(this.config.proxyUrl);
            return {
                host: url.hostname,
                port: url.port || (url.protocol === 'https:' ? '443' : '80'),
                username: decodeURIComponent(url.username || ''),
                password: decodeURIComponent(url.password || ''),
            };
        } catch (err) {
            logger.warn('Failed to parse proxy URL', { error: err.message });
            return null;
        }
    }

    /**
     * Internal browser launch
     * @returns {Promise<Browser>}
     */
    async _launchBrowser() {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            `--window-size=${this.config.viewportWidth},${this.config.viewportHeight}`,
        ];

        // Add proxy if configured
        const proxyInfo = this.parseProxyUrl();
        if (this.config.useProxy && proxyInfo) {
            args.push(`--proxy-server=${proxyInfo.host}:${proxyInfo.port}`);
            logger.info('Browser using proxy', { host: proxyInfo.host, port: proxyInfo.port });
        }

        const launchOptions = {
            headless: 'new',
            args,
            defaultViewport: {
                width: this.config.viewportWidth,
                height: this.config.viewportHeight,
            },
        };

        logger.debug('Launching browser', { useProxy: !!proxyInfo });
        return puppeteer.launch(launchOptions);
    }

    /**
     * Apply stealth settings to a page to avoid bot detection
     * @param {Page} page - Puppeteer page
     */
    async applyStealthSettings(page) {
        // Authenticate with proxy if configured
        const proxyInfo = this.parseProxyUrl();
        if (this.config.useProxy && proxyInfo && proxyInfo.username) {
            await page.authenticate({
                username: proxyInfo.username,
                password: proxyInfo.password,
            });
        }

        const userAgent = getRandomUserAgent('desktop');
        await page.setUserAgent(userAgent);

        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        });

        // Remove webdriver flag
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });

            // Mock plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });

            // Mock languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });
        });
    }

    /**
     * Wait for Queue-it to pass through
     * @param {Page} page - Puppeteer page
     * @returns {Promise<boolean>} - True if passed through, false if timed out
     */
    async waitForQueueIt(page) {
        const startTime = Date.now();
        const maxWait = this.config.queueWaitTimeout;

        logger.info('Waiting for Queue-it to pass through', { maxWait });

        while (Date.now() - startTime < maxWait) {
            const currentUrl = page.url();

            // Check if we've left the Queue-it domain
            if (!isQueueItUrl(currentUrl)) {
                logger.info('Passed through Queue-it', {
                    finalUrl: currentUrl,
                    waitTime: Date.now() - startTime
                });

                // Wait for the actual page to load
                try {
                    await page.waitForSelector('body', { timeout: 10000 });
                    // Give extra time for dynamic content
                    await new Promise(r => setTimeout(r, 2000));
                } catch {
                    // Body should exist, but don't fail if timeout
                }

                return true;
            }

            // Try to get queue position for logging
            try {
                const queueInfo = await page.evaluate(() => {
                    // Common Queue-it selectors
                    const positionEl = document.querySelector(
                        '.queue-position, [data-queue-position], #MainPart_pProgressbar498, .progress-text'
                    );
                    const waitTimeEl = document.querySelector(
                        '.queue-time, [data-queue-time], .expected-wait'
                    );

                    return {
                        position: positionEl?.textContent?.trim(),
                        waitTime: waitTimeEl?.textContent?.trim(),
                    };
                });

                if (queueInfo.position || queueInfo.waitTime) {
                    logger.debug('Queue-it status', queueInfo);
                }
            } catch {
                // Ignore evaluation errors
            }

            // Wait before next check
            await new Promise(r => setTimeout(r, this.config.queueCheckInterval));
        }

        logger.warn('Queue-it wait timeout exceeded', {
            maxWait,
            currentUrl: page.url()
        });
        return false;
    }

    /**
     * Wait for page to stabilize (no more navigations/network activity)
     * @param {Page} page - Puppeteer page
     * @param {number} timeout - Max wait time in ms
     */
    async waitForPageStable(page, timeout = 10000) {
        const startTime = Date.now();
        let lastUrl = page.url();
        let stableCount = 0;
        const stableRequired = 3; // Need 3 consecutive stable checks

        while (Date.now() - startTime < timeout) {
            await new Promise(r => setTimeout(r, 500));

            try {
                const currentUrl = page.url();
                if (currentUrl === lastUrl) {
                    stableCount++;
                    if (stableCount >= stableRequired) {
                        // Page URL stable, now wait for network
                        try {
                            await page.waitForNetworkIdle({ timeout: 3000 });
                        } catch {
                            // Network idle timeout is OK
                        }
                        return;
                    }
                } else {
                    // URL changed, reset counter
                    lastUrl = currentUrl;
                    stableCount = 0;
                    logger.debug('Page navigated during stabilization', { newUrl: currentUrl });
                }
            } catch (err) {
                // Page might be mid-navigation
                stableCount = 0;
            }
        }

        logger.debug('Page stabilization timeout, proceeding anyway');
    }

    /**
     * Detect if HTML content is a Chrome error/interstitial page
     * @param {string} html - HTML content
     * @returns {boolean}
     */
    isErrorPage(html) {
        if (!html) return false;
        const snippet = html.substring(0, 2000).toLowerCase();
        return (
            snippet.includes('chromium authors') ||
            snippet.includes('err_') ||
            snippet.includes('net::err_') ||
            snippet.includes("this site can't be reached") ||
            snippet.includes('your connection is not private') ||
            snippet.includes('ssl_error') ||
            (snippet.includes('<title>') && !snippet.includes('imax') && snippet.includes('.com.au</title>'))
        );
    }

    /**
     * Fetch a page and return its HTML content
     * @param {string} url - URL to fetch
     * @param {object} options - Options
     * @returns {Promise<{html: string, finalUrl: string, passedQueueIt: boolean}>}
     */
    async getPageHtml(url, options = {}) {
        const { retryWithoutProxy = true } = options;
        const browser = await this.ensureBrowser();
        const page = await browser.newPage();
        this.trackPageOpen();

        try {
            await this.applyStealthSettings(page);

            logger.debug('Navigating to URL', { url });

            // Navigate to the page
            const response = await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: this.config.navigationTimeout,
            });

            let passedQueueIt = false;
            const currentUrl = page.url();

            // Check if we landed on Queue-it
            if (isQueueItUrl(currentUrl)) {
                logger.info('Landed on Queue-it waiting room', { currentUrl });
                passedQueueIt = await this.waitForQueueIt(page);

                if (!passedQueueIt) {
                    throw new Error('Queue-it timeout - still in waiting room after ' +
                        (this.config.queueWaitTimeout / 1000) + ' seconds');
                }
            }

            // Wait for page to stabilize (handles JavaScript redirects)
            await this.waitForPageStable(page);

            // Get the final HTML content
            const html = await page.content();
            const finalUrl = page.url();

            // Check for Chrome error pages (often caused by proxy issues)
            if (this.isErrorPage(html) && this.config.useProxy && retryWithoutProxy) {
                logger.warn('Detected Chrome error page, retrying without proxy', { url });
                await page.close();
                this.trackPageClose();

                // Create a new browser instance without proxy for this request
                return this.getPageHtmlWithoutProxy(url);
            }

            logger.debug('Page fetched successfully', {
                url,
                finalUrl,
                passedQueueIt,
                contentLength: html.length
            });

            return {
                html,
                finalUrl,
                passedQueueIt,
                status: response?.status() || 200,
            };

        } finally {
            await page.close().catch(() => {});
            this.trackPageClose();
        }
    }

    /**
     * Fetch a page without using proxy (fallback for proxy errors)
     * @param {string} url - URL to fetch
     * @returns {Promise<{html: string, finalUrl: string, passedQueueIt: boolean}>}
     */
    async getPageHtmlWithoutProxy(url) {
        logger.info('Launching browser without proxy for fallback', { url });

        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            `--window-size=${this.config.viewportWidth},${this.config.viewportHeight}`,
        ];

        const browser = await puppeteer.launch({
            headless: 'new',
            args,
            defaultViewport: {
                width: this.config.viewportWidth,
                height: this.config.viewportHeight,
            },
        });

        const page = await browser.newPage();

        try {
            // Apply stealth settings but skip proxy auth
            const userAgent = getRandomUserAgent('desktop');
            await page.setUserAgent(userAgent);
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            });
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            });

            const response = await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: this.config.navigationTimeout,
            });

            let passedQueueIt = false;
            const currentUrl = page.url();

            if (isQueueItUrl(currentUrl)) {
                logger.info('Queue-it detected in no-proxy fallback', { currentUrl });
                passedQueueIt = await this.waitForQueueIt(page);
                if (!passedQueueIt) {
                    throw new Error('Queue-it timeout in no-proxy fallback');
                }
            }

            await this.waitForPageStable(page);
            const html = await page.content();
            const finalUrl = page.url();

            logger.info('Page fetched successfully without proxy', {
                url,
                finalUrl,
                passedQueueIt,
                contentLength: html.length
            });

            return {
                html,
                finalUrl,
                passedQueueIt,
                status: response?.status() || 200,
            };

        } finally {
            await page.close().catch(() => {});
            await browser.close().catch(() => {});
        }
    }

    /**
     * Internal browser close (without mutex - used during restart)
     */
    async _closeBrowserInternal() {
        if (this.browser) {
            try {
                await this.browser.close();
                logger.info('Browser closed', { pagesProcessed: this.pageCount });
            } catch (error) {
                logger.error('Error closing browser', { error: error.message });
            } finally {
                this.browser = null;
                this.pageCount = 0;
                this.activePages = 0;
            }
        }
    }

    /**
     * Pre-warm the browser by visiting a URL and passing through Queue-it
     * This establishes cookies that subsequent requests can reuse
     * @param {string} url - URL to visit (should be on the protected domain)
     * @param {number} timeout - Max time to wait in ms (default: 60000)
     * @returns {Promise<{success: boolean, passedQueueIt: boolean, error?: string}>}
     */
    async preWarmQueueIt(url, timeout = 60000) {
        const browser = await this.ensureBrowser();
        const page = await browser.newPage();
        this.trackPageOpen();

        const startTime = Date.now();

        try {
            await this.applyStealthSettings(page);

            logger.info('Pre-warming browser for Queue-it', { url });

            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout,
            });

            let passedQueueIt = false;
            const currentUrl = page.url();

            if (isQueueItUrl(currentUrl)) {
                logger.info('Queue-it detected during pre-warm, waiting...', { currentUrl });
                passedQueueIt = await this.waitForQueueIt(page);

                if (!passedQueueIt) {
                    return {
                        success: false,
                        passedQueueIt: false,
                        error: 'Queue-it timeout during pre-warm',
                    };
                }
            }

            logger.info('Browser pre-warmed successfully', {
                url,
                passedQueueIt,
                elapsed: Date.now() - startTime,
            });

            return {
                success: true,
                passedQueueIt,
            };

        } catch (error) {
            logger.error('Pre-warm failed', { url, error: error.message });
            return {
                success: false,
                passedQueueIt: false,
                error: error.message,
            };
        } finally {
            await page.close();
            this.trackPageClose();
        }
    }

    /**
     * Create an isolated browser context with its own cookies/storage
     * Use this for parallel operations that shouldn't share state
     * @returns {Promise<BrowserContext>}
     */
    async createContext() {
        const browser = await this.ensureBrowser();
        const context = await browser.createBrowserContext();
        logger.debug('Created isolated browser context');
        return context;
    }

    /**
     * Pre-warm a browser context by visiting a URL and passing through Queue-it
     * Establishes cookies in this specific context for subsequent requests
     * @param {BrowserContext} context - The browser context to warm
     * @param {string} url - URL to visit (should be on the protected domain)
     * @param {number} timeout - Max time to wait in ms (default: 60000)
     * @returns {Promise<{success: boolean, passedQueueIt: boolean, error?: string}>}
     */
    async preWarmContext(context, url, timeout = 60000) {
        const page = await context.newPage();
        this.trackPageOpen();

        const startTime = Date.now();

        try {
            await this.applyStealthSettings(page);

            logger.debug('Pre-warming context for Queue-it', { url });

            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout,
            });

            let passedQueueIt = false;
            const currentUrl = page.url();

            if (isQueueItUrl(currentUrl)) {
                logger.debug('Queue-it detected in context, waiting...', { currentUrl });
                passedQueueIt = await this.waitForQueueIt(page);

                if (!passedQueueIt) {
                    return {
                        success: false,
                        passedQueueIt: false,
                        error: 'Queue-it timeout during context pre-warm',
                    };
                }
            }

            logger.debug('Context pre-warmed successfully', {
                elapsed: Date.now() - startTime,
                passedQueueIt,
            });

            return {
                success: true,
                passedQueueIt,
            };

        } catch (error) {
            logger.warn('Context pre-warm failed', { url, error: error.message });
            return {
                success: false,
                passedQueueIt: false,
                error: error.message,
            };
        } finally {
            await page.close();
            this.trackPageClose();
        }
    }

    /**
     * Close a browser context
     * @param {BrowserContext} context - The context to close
     */
    async closeContext(context) {
        try {
            await context.close();
            logger.debug('Closed browser context');
        } catch (error) {
            logger.warn('Error closing browser context', { error: error.message });
        }
    }

    /**
     * Close the browser instance (public, thread-safe)
     */
    async close() {
        await this.mutex.acquire();
        try {
            await this._closeBrowserInternal();
        } finally {
            this.mutex.release();
        }
    }

    /**
     * Check if browser is currently active
     * @returns {boolean}
     */
    isActive() {
        return this.browser !== null && this.browser.connected;
    }
}

// Singleton instance for shared use
let sharedInstance = null;
let noProxyInstance = null;
let shutdownRegistered = false;

/**
 * Get the shared browser client instance
 * @param {object} options - Options for the client
 * @returns {BrowserClient}
 */
function getBrowserClient(options = {}) {
    if (!sharedInstance) {
        sharedInstance = new BrowserClient(options);

        // Register graceful shutdown handlers once
        if (!shutdownRegistered) {
            shutdownRegistered = true;
            registerShutdownHandlers();
        }
    }
    return sharedInstance;
}

/**
 * Get a browser client instance that doesn't use proxy
 * Useful for sites that have issues with proxy (like IMAX Melbourne)
 * @returns {BrowserClient}
 */
function getNoProxyBrowserClient() {
    if (!noProxyInstance) {
        noProxyInstance = new BrowserClient({
            useProxy: false,
            proxyUrl: null,
        });
        logger.info('Created no-proxy browser client for direct connections');
    }
    return noProxyInstance;
}

/**
 * Close the shared browser client
 */
async function closeBrowserClient() {
    if (sharedInstance) {
        await sharedInstance.close();
        sharedInstance = null;
    }
    if (noProxyInstance) {
        await noProxyInstance.close();
        noProxyInstance = null;
    }
}

/**
 * Register process-level shutdown handlers for cleanup
 */
function registerShutdownHandlers() {
    const shutdown = async (signal) => {
        logger.info(`Received ${signal}, closing browser...`);
        await closeBrowserClient();
    };

    // Handle common termination signals
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));

    // Handle process exit (last chance cleanup)
    process.once('beforeExit', async () => {
        await closeBrowserClient();
    });

    // Handle uncaught exceptions
    process.once('uncaughtException', async (error) => {
        logger.error('Uncaught exception, closing browser', { error: error.message });
        await closeBrowserClient();
    });

    logger.debug('Registered browser shutdown handlers');
}

module.exports = {
    BrowserClient,
    getBrowserClient,
    getNoProxyBrowserClient,
    closeBrowserClient,
};
