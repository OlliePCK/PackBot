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
     * Internal browser launch
     * @returns {Promise<Browser>}
     */
    async _launchBrowser() {
        const launchOptions = {
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                `--window-size=${this.config.viewportWidth},${this.config.viewportHeight}`,
            ],
            defaultViewport: {
                width: this.config.viewportWidth,
                height: this.config.viewportHeight,
            },
        };

        logger.debug('Launching browser', { options: launchOptions });
        return puppeteer.launch(launchOptions);
    }

    /**
     * Apply stealth settings to a page to avoid bot detection
     * @param {Page} page - Puppeteer page
     */
    async applyStealthSettings(page) {
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
     * Fetch a page and return its HTML content
     * @param {string} url - URL to fetch
     * @param {object} options - Options
     * @returns {Promise<{html: string, finalUrl: string, passedQueueIt: boolean}>}
     */
    async getPageHtml(url, options = {}) {
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

            // Get the final HTML content
            const html = await page.content();
            const finalUrl = page.url();

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
            await page.close();
            this.trackPageClose();
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
 * Close the shared browser client
 */
async function closeBrowserClient() {
    if (sharedInstance) {
        await sharedInstance.close();
        sharedInstance = null;
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
    closeBrowserClient,
};
