/**
 * IMAX Melbourne Parser
 * Handles session discovery and seat map parsing for IMAX Melbourne (Vista ticketing)
 */

const logger = require('../logger').child('imax-parser');
const { defaultClient } = require('./httpClient');
const { getBrowserClient } = require('./browserClient');
const cheerio = require('cheerio');

// Configuration
const IMAX_CONFIG = {
    baseUrl: 'https://imaxmelbourne.com.au',
    ticketingUrl: 'https://ticketing.imaxmelbourne.com.au',
    sessionsPath: '/html/day_sessions',
    movieSessionsPath: '/html/movie_sessions',
    bookingPath: '/Ticketing/visSelectTickets.aspx',

    // Optimal seating criteria
    optimalRows: 4,           // Last 4 rows
    centerPercent: 0.50,      // Middle 50% of row

    // Rate limiting
    scanDelayMs: 1500,        // Delay between session batches
    maxConcurrentSessions: 14, // Max parallel session scans
    sessionsPerWorker: 12,    // Auto-scale workers per N sessions

    // Timeouts
    seatMapTimeout: 30000,    // Wait for seat map to load

    // Retry configuration
    maxRetries: 3,            // Max retry attempts
    retryDelayMs: 2000,       // Base delay between retries
    retryBackoffMultiplier: 1.5, // Exponential backoff multiplier
};

/**
 * Retry wrapper with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {object} options - Retry options
 * @returns {Promise<any>} Result of the function
 */
async function withRetry(fn, options = {}) {
    const {
        maxRetries = IMAX_CONFIG.maxRetries,
        baseDelayMs = IMAX_CONFIG.retryDelayMs,
        backoffMultiplier = IMAX_CONFIG.retryBackoffMultiplier,
        shouldRetry = (error) => true, // Default: retry all errors
        context = 'operation',
    } = options;

    let lastError;
    let delay = baseDelayMs;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Check if we should retry this error
            if (!shouldRetry(error) || attempt === maxRetries) {
                throw error;
            }

            logger.warn(`${context} failed, retrying (${attempt}/${maxRetries})`, {
                error: error.message,
                nextRetryIn: delay,
            });

            // Wait before retry with exponential backoff
            await new Promise(r => setTimeout(r, delay));
            delay = Math.round(delay * backoffMultiplier);
        }
    }

    throw lastError;
}

/**
 * Determine if an error is retryable (transient)
 */
function isRetryableError(error) {
    const message = error.message?.toLowerCase() || '';

    // Retryable: timeouts, network errors, temporary issues
    const retryablePatterns = [
        'timeout',
        'timed out',
        'net::',
        'network',
        'econnreset',
        'econnrefused',
        'socket hang up',
        'queue-it timeout',
        'navigation timeout',
    ];

    // Not retryable: authentication, not found, etc.
    const nonRetryablePatterns = [
        'invalid session',
        'session not found',
        'unauthorized',
        '403',
        '404',
    ];

    if (nonRetryablePatterns.some(p => message.includes(p))) {
        return false;
    }

    return retryablePatterns.some(p => message.includes(p));
}

/**
 * Select tickets on a Vista ticketing page
 * Shared helper used by both seat map fetching and checkout prefill
 * @param {Page} page - Puppeteer page object
 * @param {number} numTickets - Number of tickets to select
 * @param {object} options - Options
 * @returns {Promise<{success: boolean, ticketId?: string, name?: string, error?: string}>}
 */
async function selectTicketsOnPage(page, numTickets, options = {}) {
    const { ticketType = 'adult', excludePremium = true } = options;

    return page.evaluate((qty, type, excludePrem) => {
        // Look for matching ticket input by scanning table rows
        const rows = document.querySelectorAll('tr');
        for (const row of rows) {
            const ticketName = row.querySelector('.ticket-name, .ticket-description');
            if (!ticketName) continue;

            const nameText = ticketName.textContent.toLowerCase();

            // Check if this matches our ticket type
            const matchesType = nameText.includes(type);
            const isPremium = nameText.includes('premium');

            if (matchesType && (!excludePrem || !isPremium)) {
                const input = row.querySelector('input.quantity');
                if (input) {
                    input.value = qty.toString();
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    return {
                        success: true,
                        ticketId: input.id,
                        name: ticketName.textContent.trim(),
                    };
                }
            }
        }

        // Fallback: just use the first quantity input
        const firstInput = document.querySelector('input.quantity');
        if (firstInput) {
            firstInput.value = qty.toString();
            firstInput.dispatchEvent(new Event('change', { bubbles: true }));
            firstInput.dispatchEvent(new Event('input', { bubbles: true }));
            return { success: true, ticketId: firstInput.id, name: 'first available' };
        }

        return { success: false, error: 'Could not find ticket quantity input' };
    }, numTickets, ticketType, excludePremium);
}

/**
 * Click the Next/Order button on Vista ticket selection page
 * @param {Page} page - Puppeteer page object
 * @returns {Promise<boolean>} Whether the button was clicked
 */
async function clickNextButton(page) {
    return page.evaluate(() => {
        const nextBtn = document.querySelector('#ibtnOrderTickets');
        if (nextBtn && !nextBtn.disabled) {
            nextBtn.click();
            return true;
        }
        // Fallback: try submitting the form directly
        const form = document.querySelector('#frmSelectTickets');
        if (form) {
            if (typeof __doPostBack === 'function') {
                __doPostBack('ctl00$ContentBody$ibtnOrderTickets', '');
                return true;
            }
        }
        return false;
    });
}

const MONTHS = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
};

function extractSessionIdFromUrl(url) {
    if (!url) return null;
    const match = url.match(/(?:txtSessionId|tnpSessionId)=(\d+)/);
    return match ? match[1] : null;
}

function normalizeImaxUrl(href) {
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('/Ticketing')) {
        return `${IMAX_CONFIG.ticketingUrl}${href}`;
    }
    return `${IMAX_CONFIG.baseUrl}${href}`;
}

function parseImaxSessionDate(dateText) {
    if (!dateText) return null;
    const match = dateText.trim().match(/(?:\w+\s+)?([A-Za-z]+)\s+(\d{1,2})/);
    if (!match) return null;

    const monthName = match[1].toLowerCase();
    const day = parseInt(match[2], 10);
    if (!Object.prototype.hasOwnProperty.call(MONTHS, monthName)) return null;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let year = now.getFullYear();
    let date = new Date(year, MONTHS[monthName], day);

    if (date < today) {
        year += 1;
    }

    const month = String(MONTHS[monthName] + 1).padStart(2, '0');
    const dayStr = String(day).padStart(2, '0');
    return `${year}-${month}-${dayStr}`;
}

function parseImaxMovieId(input) {
    if (!input) return null;
    const trimmed = String(input).trim();
    if (/^\d+$/.test(trimmed)) return trimmed;

    const urlMatch = trimmed.match(/movie=(\d+)/i);
    if (urlMatch) return urlMatch[1];

    const pathMatch = trimmed.match(/\/html\/movie_sessions\/(\d+)/i);
    if (pathMatch) return pathMatch[1];

    return null;
}

function resolveConcurrency(totalSessions, options = {}) {
    if (Number.isFinite(options.maxConcurrentSessions)) {
        return Math.max(1, Math.min(totalSessions, options.maxConcurrentSessions));
    }

    const sessionsPerWorker = Number.isFinite(options.sessionsPerWorker) && options.sessionsPerWorker > 0 ?
        options.sessionsPerWorker : IMAX_CONFIG.sessionsPerWorker;
    const maxConcurrent = IMAX_CONFIG.maxConcurrentSessions;
    const computed = Math.ceil(totalSessions / sessionsPerWorker);

    return Math.max(1, Math.min(totalSessions, maxConcurrent, computed));
}

async function scanSessionsInBatches(sessionsToScan, concurrency, delayMs, worker, options = {}) {
    const { onProgress } = options;
    const results = [];
    const total = sessionsToScan.length;
    let optimalFound = 0;
    let scannedCount = 0;

    for (let i = 0; i < total; i += concurrency) {
        const batch = sessionsToScan.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map((session, index) => worker(session, i + index, total))
        );

        results.push(...batchResults);
        scannedCount += batchResults.length;

        // Count optimal results for progress reporting
        for (const result of batchResults) {
            if (result.hasOptimal) optimalFound++;
        }

        // Report progress after each batch
        if (onProgress) {
            try {
                await onProgress({
                    scanned: scannedCount,
                    total,
                    optimalFound,
                    percent: Math.round((scannedCount / total) * 100),
                });
            } catch (err) {
                // Don't let progress callback errors break the scan
                logger.debug('Progress callback error', { error: err.message });
            }
        }

        if (delayMs > 0 && i + concurrency < total) {
            await new Promise(r => setTimeout(r, delayMs));
        }
    }

    return results;
}

async function resolveImaxMovieId(movieInput) {
    const direct = parseImaxMovieId(movieInput);
    if (direct) return direct;

    let normalizedInput = String(movieInput || '').trim();
    if (/^imaxmelbourne\.com\.au/i.test(normalizedInput)) {
        normalizedInput = `https://${normalizedInput}`;
    }

    const normalized = normalizeImaxUrl(normalizedInput);
    if (!normalized || !/\/movie\//i.test(normalized)) {
        return null;
    }

    const response = await defaultClient.get(normalized);
    let html = response.text || '';

    if ((!response.ok && response.requiresBrowser) || response.queueItDetected) {
        const browserClient = getBrowserClient();
        const pageResult = await browserClient.getPageHtml(normalized);
        html = pageResult.html || '';
    } else if (!response.ok) {
        throw new Error(`Failed to fetch movie page: ${response.status}`);
    }
    let match = html.match(/session_times_and_tickets\/\?movie=(\d+)/i);
    if (match) return match[1];

    match = html.match(/\/html\/movie_sessions\/(\d+)/i);
    if (match) return match[1];

    const $ = cheerio.load(html);
    const linkHref = $('a[href*="session_times_and_tickets"][href*="movie="]').first().attr('href');
    if (linkHref) {
        const linkMatch = linkHref.match(/movie=(\d+)/i);
        if (linkMatch) return linkMatch[1];
    }

    return null;
}

/**
 * Fetch available sessions for a given date
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Promise<Array<{sessionId: string, movie: string, time: string, url: string, isPremium: boolean, status: string}>>}
 */
async function fetchImaxSessions(date) {
    const url = `${IMAX_CONFIG.baseUrl}${IMAX_CONFIG.sessionsPath}/${date}`;
    logger.debug('Fetching IMAX sessions', { date, url });

    try {
        const response = await defaultClient.get(url);

        if (!response.ok) {
            throw new Error(`Failed to fetch sessions: ${response.status}`);
        }

        const $ = cheerio.load(response.text);
        const sessions = [];

        // Parse session list items
        // Structure: <li class="nft"><span class="time">9:45am</span><a class="movie">TITLE</a>...</li>
        $('li.nft').each((i, el) => {
            const $li = $(el);
            const time = $li.find('.time').text().trim();
            const movie = $li.find('.movie').text().trim();

            // Look for booking links with txtSessionId or tnpSessionId
            const $buyLink = $li.find('a[href*="txtSessionId"], a[href*="tnpSessionId"]');

            if ($buyLink.length > 0) {
                const href = $buyLink.attr('href');
                const sessionIdMatch = href.match(/(?:txtSessionId|tnpSessionId)=(\d+)/);

                if (sessionIdMatch) {
                    const sessionId = sessionIdMatch[1];

                    // Check status from CSS classes
                    const isPremiumSoldOut = $li.find('.soldout').length > 0 &&
                                             $li.find('.soldout').text().toLowerCase().includes('premium');
                    const isAlmostSold = $buyLink.hasClass('almostsold');
                    const isSoldOut = $buyLink.hasClass('soldout');

                    let status = 'available';
                    if (isSoldOut) status = 'sold_out';
                    else if (isAlmostSold) status = 'almost_sold';

                    sessions.push({
                        sessionId,
                        movie: movie || 'Unknown Movie',
                        time,
                        url: href,
                        isPremium: false,
                        isPremiumSoldOut,
                        status,
                    });
                }
            } else {
                // Session exists but no booking link yet (not on sale)
                sessions.push({
                    sessionId: null,
                    movie: movie || 'Unknown Movie',
                    time,
                    url: null,
                    isPremium: false,
                    status: 'not_on_sale',
                });
            }
        });

        // Also check for direct booking links we might have missed
        $('a[href*="ticketing.imaxmelbourne"]').each((i, el) => {
            const $el = $(el);
            const href = $el.attr('href');
            const sessionIdMatch = href.match(/(?:txtSessionId|tnpSessionId)=(\d+)/);

            if (sessionIdMatch) {
                const sessionId = sessionIdMatch[1];
                // Avoid duplicates
                if (!sessions.find(s => s.sessionId === sessionId)) {
                    const $li = $el.closest('li');
                    const time = $li.find('.time').text().trim();
                    const movie = $li.find('.movie').text().trim();

                    sessions.push({
                        sessionId,
                        movie: movie || 'Unknown',
                        time: time || $el.text().trim(),
                        url: href,
                        isPremium: false,
                        status: 'available',
                    });
                }
            }
        });

        logger.info('Found IMAX sessions', { date, count: sessions.length });
        return sessions;

    } catch (error) {
        logger.error('Error fetching IMAX sessions', { date, error: error.message });
        throw error;
    }
}

/**
 * Fetch available sessions for a given movie ID
 * @param {string} movieId - IMAX movie ID
 * @returns {Promise<{movieTitle: string|null, sessions: Array}>}
 */
async function fetchImaxMovieSessions(movieId) {
    const url = `${IMAX_CONFIG.baseUrl}${IMAX_CONFIG.movieSessionsPath}/${movieId}`;
    logger.debug('Fetching IMAX movie sessions', { movieId, url });

    try {
        const response = await defaultClient.get(url);

        if (!response.ok) {
            throw new Error(`Failed to fetch movie sessions: ${response.status}`);
        }

        const $ = cheerio.load(response.text);
        const movieTitle = $('h3.movie').first().text().trim() || null;
        const sessions = [];

        $('.session-block').each((i, block) => {
            const $block = $(block);
            const dateText = $block.find('.date').first().text().trim();
            const date = parseImaxSessionDate(dateText);
            const hasNft = $block.find('.nft').length > 0;

            $block.find('li').each((_, li) => {
                const $li = $(li);
                const seatingType = $li.find('.title-seating').text().trim();
                if (!seatingType) return;

                const isPremium = seatingType.toLowerCase().includes('premium');
                const timesContainer = $li.find('.times').first();
                if (!timesContainer.length) return;

                let timeElements = timesContainer.find('.time');
                if (timeElements.length === 0) {
                    timeElements = timesContainer.find('a');
                }
                if (timeElements.length === 0) {
                    timeElements = timesContainer.find('.label-time');
                }

                timeElements.each((__, el) => {
                    const $time = $(el);
                    const timeText = $time.find('.label-time').first().text().trim() ||
                        $time.text().replace(/buy/gi, '').trim();
                    if (!timeText) return;

                    const href = $time.attr('href') || $time.find('a').attr('href');
                    const url = normalizeImaxUrl(href);
                    const sessionId = extractSessionIdFromUrl(url);

                    const classList = ($time.attr('class') || '').toLowerCase();
                    let status = 'available';
                    if (classList.includes('soldout')) status = 'sold_out';
                    else if (classList.includes('almostsold') || classList.includes('filling')) status = 'almost_sold';

                    if (!sessionId && status === 'available') {
                        status = 'not_on_sale';
                    }

                    sessions.push({
                        sessionId,
                        movie: movieTitle || 'Unknown Movie',
                        date,
                        dateText,
                        time: timeText,
                        seatingType,
                        isPremium,
                        url,
                        status,
                        nft: hasNft,
                    });
                });
            });
        });

        logger.info('Found IMAX movie sessions', { movieId, count: sessions.length });
        return { movieTitle, sessions };

    } catch (error) {
        logger.error('Error fetching IMAX movie sessions', { movieId, error: error.message });
        throw error;
    }
}

/**
 * Parse movie information from the sessions page more thoroughly
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Promise<Array<{movie: string, sessions: Array}>>}
 */
async function fetchImaxMoviesWithSessions(date) {
    const url = `${IMAX_CONFIG.baseUrl}${IMAX_CONFIG.sessionsPath}/${date}`;

    try {
        const response = await defaultClient.get(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch sessions: ${response.status}`);
        }

        const $ = cheerio.load(response.text);
        const movies = [];
        let currentMovie = null;

        // Parse the HTML structure - sessions are typically grouped by movie
        $('*').each((i, el) => {
            const $el = $(el);
            const tagName = el.tagName?.toLowerCase();

            // Look for movie title headers
            if (['h2', 'h3', 'h4'].includes(tagName) || $el.hasClass('movie-title')) {
                const title = $el.text().trim();
                if (title && !title.toLowerCase().includes('session')) {
                    currentMovie = {
                        movie: title,
                        sessions: [],
                    };
                    movies.push(currentMovie);
                }
            }

            // Look for session links under current movie
            if (currentMovie) {
                const links = $el.find('a[href*="tnpSessionId"]');
                links.each((j, link) => {
                    const href = $(link).attr('href');
                    const sessionIdMatch = href.match(/tnpSessionId=(\d+)/);
                    if (sessionIdMatch) {
                        const sessionId = sessionIdMatch[1];
                        const text = $(link).text().trim();
                        const isPremium = $(link).closest('li, div').text().toLowerCase().includes('premium');

                        if (!currentMovie.sessions.find(s => s.sessionId === sessionId)) {
                            currentMovie.sessions.push({
                                sessionId,
                                time: text,
                                url: `${IMAX_CONFIG.ticketingUrl}${IMAX_CONFIG.bookingPath}?tnpSessionId=${sessionId}`,
                                isPremium,
                            });
                        }
                    }
                });
            }
        });

        return movies;

    } catch (error) {
        logger.error('Error fetching IMAX movies', { date, error: error.message });
        throw error;
    }
}

/**
 * Fetch and parse seat map for a session using headless browser
 * This navigates through the Vista ticketing flow: Select Tickets -> Select Seats
 * @param {string} sessionId - Vista session ID
 * @param {string} [sessionUrl] - Optional full URL (if known from session listing)
 * @param {number} [numTickets=2] - Number of tickets to request (affects seat map availability check)
 * @returns {Promise<{seats: Array, rows: Array, totalSeats: number, availableSeats: number, layout: object}>}
 */
async function fetchSeatMap(sessionId, sessionUrl = null, numTickets = 2) {
    // Use provided URL or construct one - Vista uses txtSessionId
    const url = sessionUrl || `${IMAX_CONFIG.ticketingUrl}${IMAX_CONFIG.bookingPath}?cinemacode=0000000001&txtSessionId=${sessionId}&visLang=1`;
    logger.info('Fetching seat map', { sessionId, url, numTickets });

    const browserClient = getBrowserClient();
    const browser = await browserClient.ensureBrowser();
    const page = await browser.newPage();

    try {
        await browserClient.applyStealthSettings(page);

        // Step 1: Navigate to the ticket selection page
        logger.debug('Step 1: Loading ticket selection page', { sessionId });
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        // Check for Queue-it and wait if needed
        const { isQueueItUrl } = require('./queueitDetector');
        if (isQueueItUrl(page.url())) {
            logger.info('Queue-it detected for seat map, waiting...', { sessionId });
            const passed = await browserClient.waitForQueueIt(page);
            if (!passed) {
                throw new Error('Queue-it timeout while fetching seat map');
            }
        }

        // Step 2: Select tickets using shared helper
        logger.debug('Step 2: Selecting tickets', { sessionId, numTickets });
        await page.waitForSelector('input.quantity', { timeout: 10000 });

        const ticketSet = await selectTicketsOnPage(page, numTickets);
        if (!ticketSet.success) {
            throw new Error(ticketSet.error || 'Could not find ticket quantity input');
        }
        logger.debug('Ticket selected', { ticketId: ticketSet.ticketId, name: ticketSet.name });

        // Wait a moment for the form to update
        await new Promise(r => setTimeout(r, 1000));

        // Step 3: Click the "Next" button using shared helper
        logger.debug('Step 3: Clicking Next button', { sessionId });
        const nextClicked = await clickNextButton(page);
        if (!nextClicked) {
            throw new Error('Could not click Next button to proceed to seat selection');
        }

        // Wait for navigation to seat selection page
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
            logger.debug('Navigation wait timeout - checking if page changed', { sessionId });
        });

        // Wait a bit more for dynamic content
        await new Promise(r => setTimeout(r, 2000));

        logger.debug('Step 4: Parsing seat map', { sessionId, currentUrl: page.url() });

        // Check if we're now on a seat selection page
        const pageTitle = await page.title();
        logger.debug('Current page', { title: pageTitle, url: page.url() });

        // Wait for seat map to load - Vista uses various formats
        await page.waitForFunction(() => {
            // Look for any seat-like elements
            const selectors = [
                '[data-seat]', '.seat', '[data-row]',
                'svg rect', 'svg circle', '.seatmap',
                '[id*="seat"]', '[class*="seat"]',
                'table.seating-plan td', // Vista table-based seat maps
                '.seat-row', '.seat-available', '.seat-sold',
                '#seat-plan', '#seatmap', '.venue-map',
            ];
            for (const sel of selectors) {
                const elements = document.querySelectorAll(sel);
                if (elements.length > 10) return true; // Found enough elements
            }
            return false;
        }, { timeout: IMAX_CONFIG.seatMapTimeout }).catch(() => {
            logger.warn('Seat map elements not found with standard selectors', { sessionId });
        });

        // Give extra time for dynamic content
        await new Promise(r => setTimeout(r, 2000));

        // Extract seat data from the page
        const seatData = await page.evaluate(() => {
            const result = {
                seats: [],
                rows: [],
                selectors: [],
                debug: {},
            };

            // Try multiple strategies to find seats
            const strategies = [
                // Strategy 0: Vista seat map (IMAX Melbourne specific)
                // Seats are <img> elements with data-row, data-col, data-name, data-type attributes
                () => {
                    const seats = document.querySelectorAll('img[data-row][data-col][data-type]');
                    if (seats.length > 10) {
                        result.selectors.push('Vista img[data-row][data-col][data-type]');
                        return Array.from(seats).map(s => {
                            const dataType = s.getAttribute('data-type');
                            // Vista data-type values: "Empty" = available, "Sold" = sold
                            let status = 'unknown';
                            if (dataType === 'Empty') status = 'available';
                            else if (dataType === 'Sold') status = 'sold';
                            else if (dataType === 'Selected') status = 'selected';
                            else if (dataType === 'Wheelchair' || dataType === 'Companion') status = 'special';

                            return {
                                id: `${s.getAttribute('data-name')}-${s.getAttribute('data-col')}`,
                                row: s.getAttribute('data-name'),  // Row label (A, B, C...)
                                rowNum: parseInt(s.getAttribute('data-row')),  // Row number
                                col: parseInt(s.getAttribute('data-col')),  // Column/seat number
                                seat: s.getAttribute('data-col'),
                                status,
                                dataType,
                                x: s.getBoundingClientRect().x,
                                y: s.getBoundingClientRect().y,
                                src: s.src,
                            };
                        });
                    }
                    return null;
                },

                // Strategy 1: Data attributes
                () => {
                    const seats = document.querySelectorAll('[data-seat-id], [data-seat], [data-seatid]');
                    if (seats.length > 20) {
                        result.selectors.push('[data-seat*]');
                        return Array.from(seats).map(s => ({
                            id: s.getAttribute('data-seat-id') || s.getAttribute('data-seat') || s.getAttribute('data-seatid'),
                            row: s.getAttribute('data-row') || s.getAttribute('data-row-id'),
                            seat: s.getAttribute('data-seat-number') || s.getAttribute('data-num'),
                            status: s.getAttribute('data-status') || s.getAttribute('data-available') ||
                                    (s.classList.contains('available') ? 'available' :
                                     s.classList.contains('sold') || s.classList.contains('occupied') ? 'sold' : 'unknown'),
                            x: s.getBoundingClientRect().x,
                            y: s.getBoundingClientRect().y,
                            classes: s.className,
                        }));
                    }
                    return null;
                },

                // Strategy 2: Class-based seats
                () => {
                    const seats = document.querySelectorAll('.seat, .seat-available, .seat-sold, [class*="seat"]');
                    if (seats.length > 20) {
                        result.selectors.push('.seat*');
                        return Array.from(seats).map(s => {
                            const classList = s.className.toLowerCase();
                            let status = 'unknown';
                            if (classList.includes('available') || classList.includes('free')) status = 'available';
                            else if (classList.includes('sold') || classList.includes('occupied') || classList.includes('taken')) status = 'sold';
                            else if (classList.includes('blocked') || classList.includes('reserved')) status = 'blocked';

                            return {
                                id: s.id || null,
                                row: s.getAttribute('data-row') || null,
                                seat: s.getAttribute('data-seat') || s.innerText?.trim() || null,
                                status,
                                x: s.getBoundingClientRect().x,
                                y: s.getBoundingClientRect().y,
                                classes: s.className,
                            };
                        });
                    }
                    return null;
                },

                // Strategy 3: SVG elements
                () => {
                    const svgSeats = document.querySelectorAll('svg rect, svg circle, svg path[data-seat]');
                    if (svgSeats.length > 20) {
                        result.selectors.push('svg elements');
                        return Array.from(svgSeats).map(s => {
                            const fill = s.getAttribute('fill') || window.getComputedStyle(s).fill;
                            // Green/blue typically available, red/gray typically sold
                            let status = 'unknown';
                            if (fill.includes('green') || fill.includes('#0') || fill.includes('rgb(0')) status = 'available';
                            else if (fill.includes('red') || fill.includes('gray') || fill.includes('grey')) status = 'sold';

                            return {
                                id: s.id || s.getAttribute('data-id') || null,
                                row: s.getAttribute('data-row') || null,
                                seat: s.getAttribute('data-seat') || null,
                                status,
                                x: parseFloat(s.getAttribute('x') || s.getAttribute('cx') || s.getBoundingClientRect().x),
                                y: parseFloat(s.getAttribute('y') || s.getAttribute('cy') || s.getBoundingClientRect().y),
                                fill,
                            };
                        });
                    }
                    return null;
                },

                // Strategy 4: Table-based layout (older Vista)
                () => {
                    const cells = document.querySelectorAll('table td[onclick], table td.seat');
                    if (cells.length > 20) {
                        result.selectors.push('table cells');
                        return Array.from(cells).map((s, idx) => {
                            const classList = s.className.toLowerCase();
                            let status = 'unknown';
                            if (classList.includes('available') || classList.includes('free') || s.style.cursor === 'pointer') status = 'available';
                            else if (classList.includes('sold') || classList.includes('occupied')) status = 'sold';

                            return {
                                id: s.id || `cell-${idx}`,
                                row: s.closest('tr')?.getAttribute('data-row') || null,
                                seat: s.innerText?.trim() || null,
                                status,
                                x: s.getBoundingClientRect().x,
                                y: s.getBoundingClientRect().y,
                                classes: s.className,
                            };
                        });
                    }
                    return null;
                },

                // Strategy 5: ID-based lookup
                () => {
                    const seats = document.querySelectorAll('[id*="seat"], [id*="Seat"]');
                    if (seats.length > 20) {
                        result.selectors.push('[id*=seat]');
                        return Array.from(seats).map(s => ({
                            id: s.id,
                            row: null,
                            seat: null,
                            status: s.classList.contains('available') || s.getAttribute('data-available') === 'true' ? 'available' :
                                    s.classList.contains('sold') ? 'sold' : 'unknown',
                            x: s.getBoundingClientRect().x,
                            y: s.getBoundingClientRect().y,
                            classes: s.className,
                        }));
                    }
                    return null;
                },
            ];

            // Try each strategy
            for (const strategy of strategies) {
                const seats = strategy();
                if (seats && seats.length > 0) {
                    result.seats = seats;
                    break;
                }
            }

            // Debug: Get page structure
            result.debug.bodyClasses = document.body.className;
            result.debug.title = document.title;
            result.debug.hasSvg = document.querySelector('svg') !== null;
            result.debug.hasCanvas = document.querySelector('canvas') !== null;

            // Try to find row labels
            const rowLabels = document.querySelectorAll('.row-label, [data-row-label], .row-name');
            result.rows = Array.from(rowLabels).map(r => ({
                label: r.textContent?.trim(),
                y: r.getBoundingClientRect().y,
            }));

            return result;
        });

        logger.info('Extracted seat data', {
            sessionId,
            seatCount: seatData.seats.length,
            selectors: seatData.selectors,
            rowCount: seatData.rows.length,
        });

        if (seatData.seats.length === 0) {
            logger.warn('No seats found in seat map', { sessionId, debug: seatData.debug });
        }

        // Process the raw seat data into a structured layout
        const layout = processSeatLayout(seatData);

        return {
            raw: seatData,
            ...layout,
        };

    } finally {
        await page.close();
    }
}

/**
 * Process raw seat data into structured layout with rows and columns
 * @param {object} seatData - Raw seat data from page evaluation
 * @returns {object} Processed layout
 */
function processSeatLayout(seatData) {
    const { seats, rows: rowLabels } = seatData;

    if (seats.length === 0) {
        return {
            rows: [],
            totalSeats: 0,
            availableSeats: 0,
            error: 'No seats found',
        };
    }

    // Check if we have Vista format (row labels like A, B, C)
    const hasVistaFormat = seats.some(s => s.row && /^[A-Z]$/.test(s.row));

    if (hasVistaFormat) {
        // Vista format: group by row label (A, B, C...)
        const rowGroups = new Map();

        for (const seat of seats) {
            const rowLabel = seat.row;
            if (!rowGroups.has(rowLabel)) {
                rowGroups.set(rowLabel, []);
            }
            rowGroups.get(rowLabel).push(seat);
        }

        // Convert to array and sort by row label (A=front, Z=back for IMAX)
        // Note: In Vista, data-row number decreases as you go back (row 11=A is front, row 1=K is back)
        const rowsArray = Array.from(rowGroups.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))  // A, B, C... order
            .map(([label, seats], index) => ({
                rowIndex: index,
                label,
                rowNum: seats[0]?.rowNum,  // Vista row number
                seats: seats.sort((a, b) => (a.col || 0) - (b.col || 0)),  // Sort by col ascending for consecutive detection
            }));

        // Calculate statistics
        const totalSeats = seats.length;
        const availableSeats = seats.filter(s => s.status === 'available').length;
        const soldSeats = seats.filter(s => s.status === 'sold').length;

        return {
            rows: rowsArray,
            totalRows: rowsArray.length,
            totalSeats,
            availableSeats,
            soldSeats,
            unknownSeats: totalSeats - availableSeats - soldSeats,
            format: 'vista',
        };
    }

    // Fallback: Group seats by Y coordinate (rows)
    const yTolerance = 15; // Pixels tolerance for same row
    const rowGroups = new Map();

    for (const seat of seats) {
        // Find or create row group for this Y coordinate
        let foundRow = null;
        for (const [yKey, rowSeats] of rowGroups) {
            if (Math.abs(seat.y - yKey) < yTolerance) {
                foundRow = yKey;
                break;
            }
        }

        if (foundRow !== null) {
            rowGroups.get(foundRow).push(seat);
        } else {
            rowGroups.set(seat.y, [seat]);
        }
    }

    // Convert to array and sort by Y (top to bottom = front to back)
    const rowsArray = Array.from(rowGroups.entries())
        .sort((a, b) => a[0] - b[0]) // Sort by Y coordinate
        .map(([y, seats], index) => ({
            rowIndex: index,
            y,
            label: rowLabels.find(r => Math.abs(r.y - y) < yTolerance)?.label ||
                   seats[0]?.row ||
                   String.fromCharCode(65 + index), // A, B, C...
            seats: seats.sort((a, b) => a.x - b.x), // Sort seats by X (left to right)
        }));

    // Calculate statistics
    const totalSeats = seats.length;
    const availableSeats = seats.filter(s => s.status === 'available').length;
    const soldSeats = seats.filter(s => s.status === 'sold').length;

    return {
        rows: rowsArray,
        totalRows: rowsArray.length,
        totalSeats,
        availableSeats,
        soldSeats,
        unknownSeats: totalSeats - availableSeats - soldSeats,
    };
}

/**
 * Find optimal consecutive seats in a seat map
 * @param {object} layout - Processed seat layout
 * @param {number} numSeats - Number of consecutive seats needed
 * @param {object} config - Configuration for optimal zone
 * @returns {Array<{row: string, rowIndex: number, startSeat: number, endSeat: number, seats: Array, isOptimal: boolean}>}
 */
function findOptimalSeats(layout, numSeats = 2, config = {}) {
    const {
        optimalRows = IMAX_CONFIG.optimalRows,
        centerPercent = IMAX_CONFIG.centerPercent,
    } = config;

    const results = [];

    if (!layout.rows || layout.rows.length === 0) {
        return results;
    }

    const totalRows = layout.rows.length;
    const optimalRowStart = Math.max(0, totalRows - optimalRows);

    // Process rows from back to front (higher Y = further back = more optimal)
    const rowsBackToFront = [...layout.rows].reverse();

    for (const row of rowsBackToFront) {
        const availableSeats = row.seats.filter(s => s.status === 'available');
        if (availableSeats.length < numSeats) continue;

        // Find consecutive groups
        const consecutiveGroups = findConsecutiveSeats(availableSeats, numSeats);

        for (const group of consecutiveGroups) {
            // Check if group is in center zone using actual seat column positions
            // For Vista format, use column numbers; for others, use X coordinates
            const hasColNumbers = row.seats.some(s => s.col !== undefined);
            let isInCenter = false;
            let centerScore = 0;

            if (hasColNumbers) {
                // Vista format: use actual column numbers to determine center
                // Get all column numbers in the row to find the range
                const allCols = row.seats.map(s => s.col).filter(c => c !== undefined);
                const minCol = Math.min(...allCols);
                const maxCol = Math.max(...allCols);
                const colRange = maxCol - minCol;
                const rowCenter = (minCol + maxCol) / 2;

                // Calculate center zone boundaries based on column positions
                const centerHalfWidth = (colRange * centerPercent) / 2;
                const centerColStart = rowCenter - centerHalfWidth;
                const centerColEnd = rowCenter + centerHalfWidth;

                // Get the group's column positions
                const groupCols = group.map(s => s.col).filter(c => c !== undefined);
                const groupMinCol = Math.min(...groupCols);
                const groupMaxCol = Math.max(...groupCols);
                const groupCenter = (groupMinCol + groupMaxCol) / 2;

                // Check if group is within center zone
                isInCenter = groupMinCol >= centerColStart && groupMaxCol <= centerColEnd;

                // Calculate how centered the group is (0 = edge, 1 = perfect center)
                centerScore = 1 - Math.abs(groupCenter - rowCenter) / (colRange / 2);
            } else {
                // Fallback: use array indices for non-Vista format
                const rowWidth = row.seats.length;
                const centerStart = Math.floor(rowWidth * (1 - centerPercent) / 2);
                const centerEnd = Math.floor(rowWidth * (1 + centerPercent) / 2);

                const groupIndices = group.map(s => row.seats.indexOf(s));
                const minIndex = Math.min(...groupIndices);
                const maxIndex = Math.max(...groupIndices);

                isInCenter = minIndex >= centerStart && maxIndex <= centerEnd;
                centerScore = 1 - Math.abs((minIndex + maxIndex) / 2 - rowWidth / 2) / (rowWidth / 2);
            }

            const isInOptimalRows = row.rowIndex >= optimalRowStart;
            const isOptimal = isInCenter && isInOptimalRows;

            // Get seat labels for display
            const groupCols = group.map(s => s.col).filter(c => c !== undefined);
            const seatRange = groupCols.length > 0
                ? `${Math.min(...groupCols)}-${Math.max(...groupCols)}`
                : `${group.length} seats`;

            results.push({
                row: row.label,
                rowIndex: row.rowIndex,
                startSeatIndex: Math.min(...group.map(s => row.seats.indexOf(s))),
                endSeatIndex: Math.max(...group.map(s => row.seats.indexOf(s))),
                seatCount: group.length,
                seatRange,
                seats: group,
                isInCenter,
                isInOptimalRows,
                isOptimal,
                centerScore: Math.round(centerScore * 100) / 100,
            });
        }
    }

    // Sort by optimality: optimal first, then by center score (most centered first), then by row (back to front)
    results.sort((a, b) => {
        if (a.isOptimal !== b.isOptimal) return b.isOptimal - a.isOptimal;
        if (a.isOptimal && b.isOptimal) {
            // Both optimal - prefer more centered
            if (Math.abs(a.centerScore - b.centerScore) > 0.1) {
                return b.centerScore - a.centerScore;
            }
        }
        return b.rowIndex - a.rowIndex;
    });

    return results;
}

/**
 * Find consecutive available seats in a row
 * @param {Array} seats - Array of available seats (already sorted)
 * @param {number} minCount - Minimum number of consecutive seats
 * @returns {Array<Array>} Groups of consecutive seats
 */
function findConsecutiveSeats(seats, minCount) {
    const groups = [];
    let currentGroup = [];

    // Check if seats have column numbers (Vista format)
    const hasColNumbers = seats.some(s => s.col !== undefined);

    for (let i = 0; i < seats.length; i++) {
        if (currentGroup.length === 0) {
            currentGroup.push(seats[i]);
        } else {
            const lastSeat = currentGroup[currentGroup.length - 1];
            let isAdjacent = false;

            if (hasColNumbers) {
                // Vista format: check if column numbers are adjacent (diff of 1)
                const colDiff = Math.abs((seats[i].col || 0) - (lastSeat.col || 0));
                isAdjacent = colDiff === 1;
            } else {
                // Fallback: use X coordinates
                const xTolerance = 80; // Pixels
                const gap = Math.abs(seats[i].x - lastSeat.x);
                isAdjacent = gap < xTolerance;
            }

            if (isAdjacent) {
                currentGroup.push(seats[i]);
            } else {
                // Gap too large, save current group and start new one
                if (currentGroup.length >= minCount) {
                    groups.push([...currentGroup]);
                }
                currentGroup = [seats[i]];
            }
        }
    }

    // Don't forget the last group
    if (currentGroup.length >= minCount) {
        groups.push(currentGroup);
    }

    return groups;
}

/**
 * Scan all sessions for a date and find optimal seating
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {number} numSeats - Number of consecutive seats needed
 * @param {object} options - Scan options
 * @returns {Promise<object>} Scan results
 */
async function scanImaxDate(date, numSeats = 2, options = {}) {
    const {
        delayMs = IMAX_CONFIG.scanDelayMs,
        maxSessions,
        matchesOnly = true,
        maxConcurrentSessions,
        onProgress,
    } = options;

    logger.info('Starting IMAX date scan', { date, numSeats });

    const sessions = await fetchImaxSessions(date);

    if (sessions.length === 0) {
        return {
            date,
            scannedAt: new Date().toISOString(),
            sessions: [],
            error: 'No sessions found for this date',
        };
    }

    const results = {
        date,
        scannedAt: new Date().toISOString(),
        numSeatsRequested: numSeats,
        matchesOnly,
        sessions: [],
        summary: {
            totalSessions: sessions.length,
            sessionsScanned: 0,
            sessionsNotOnSale: 0,
            sessionsWithOptimal: 0,
            sessionsWithAvailable: 0,
        },
    };

    // Filter to only sessions that are on sale (have a sessionId)
    const bookableSessions = sessions.filter(s => s.sessionId);
    const sessionsNotOnSale = sessions.filter(s => !s.sessionId);
    let sessionsToScan = bookableSessions;

    if (Number.isFinite(maxSessions) && maxSessions > 0) {
        sessionsToScan = bookableSessions.slice(0, maxSessions);
    }

    results.summary.sessionsScanned = sessionsToScan.length;
    results.summary.sessionsNotOnSale = sessionsNotOnSale.length;

    const concurrency = resolveConcurrency(sessionsToScan.length, { maxConcurrentSessions });
    logger.info('Using session scan concurrency', { concurrency, totalSessions: sessionsToScan.length });

    const scanResults = await scanSessionsInBatches(
        sessionsToScan,
        concurrency,
        delayMs,
        async (session, index, total) => {
            logger.debug(`Scanning session ${index + 1}/${total}`, {
                sessionId: session.sessionId,
                movie: session.movie,
                time: session.time,
            });

            try {
                // Use retry wrapper for transient failures
                const seatMap = await withRetry(
                    () => fetchSeatMap(session.sessionId, session.url, numSeats),
                    {
                        shouldRetry: isRetryableError,
                        context: `fetchSeatMap(${session.sessionId})`,
                    }
                );
                const optimalSeats = findOptimalSeats(seatMap, numSeats);

                const sessionResult = {
                    ...session,
                    seatMap: {
                        totalSeats: seatMap.totalSeats,
                        availableSeats: seatMap.availableSeats,
                        soldSeats: seatMap.soldSeats,
                        totalRows: seatMap.totalRows,
                    },
                    optimalGroups: optimalSeats.filter(g => g.isOptimal),
                    availableGroups: optimalSeats.filter(g => !g.isOptimal),
                    hasOptimal: optimalSeats.some(g => g.isOptimal),
                    hasAvailable: optimalSeats.length > 0,
                };

                return {
                    sessionResult: (!matchesOnly || sessionResult.hasOptimal) ? sessionResult : null,
                    hasOptimal: sessionResult.hasOptimal,
                    hasAvailable: sessionResult.hasAvailable,
                };
            } catch (error) {
                logger.error('Error scanning session (after retries)', {
                    sessionId: session.sessionId,
                    error: error.message,
                });

                return {
                    sessionResult: !matchesOnly ? {
                        ...session,
                        error: error.message,
                        hasOptimal: false,
                        hasAvailable: false,
                    } : null,
                    hasOptimal: false,
                    hasAvailable: false,
                };
            }
        },
        { onProgress }
    );

    for (const result of scanResults) {
        if (result.hasOptimal) {
            results.summary.sessionsWithOptimal++;
        }
        if (result.hasAvailable) {
            results.summary.sessionsWithAvailable++;
        }
        if (result.sessionResult) {
            results.sessions.push(result.sessionResult);
        }
    }

    logger.info('IMAX date scan complete', {
        date,
        totalSessions: results.summary.totalSessions,
        sessionsScanned: results.summary.sessionsScanned,
        sessionsReturned: results.sessions.length,
        withOptimal: results.summary.sessionsWithOptimal,
    });

    return results;
}

/**
 * Scan all sessions for a movie and find optimal seating
 * @param {string} movieInput - Movie ID or URL containing movie ID
 * @param {number} numSeats - Number of consecutive seats needed
 * @param {object} options - Scan options
 * @returns {Promise<object>} Scan results
 */
async function scanImaxMovie(movieInput, numSeats = 2, options = {}) {
    const {
        delayMs = IMAX_CONFIG.scanDelayMs,
        maxSessions,
        matchesOnly = true,
        maxConcurrentSessions,
        onProgress,
    } = options;

    const movieId = await resolveImaxMovieId(movieInput);
    if (!movieId) {
        throw new Error('Invalid movie ID or URL');
    }

    logger.info('Starting IMAX movie scan', { movieId, numSeats });

    const { movieTitle, sessions } = await fetchImaxMovieSessions(movieId);

    if (sessions.length === 0) {
        return {
            movieId,
            movieTitle,
            scannedAt: new Date().toISOString(),
            numSeatsRequested: numSeats,
            matchesOnly,
            sessions: [],
            summary: {
                totalSessions: 0,
                sessionsScanned: 0,
                sessionsNotOnSale: 0,
                sessionsWithOptimal: 0,
                sessionsWithAvailable: 0,
            },
            error: 'No sessions found for this movie',
        };
    }

    const results = {
        movieId,
        movieTitle,
        scannedAt: new Date().toISOString(),
        numSeatsRequested: numSeats,
        matchesOnly,
        sessions: [],
        summary: {
            totalSessions: sessions.length,
            uniqueSessions: 0,
            sessionsScanned: 0,
            sessionsNotOnSale: 0,
            sessionsWithOptimal: 0,
            sessionsWithAvailable: 0,
        },
    };

    const bookableSessions = sessions.filter(s => s.sessionId);
    const sessionsNotOnSale = sessions.filter(s => !s.sessionId);
    const sessionsById = new Map();
    for (const session of bookableSessions) {
        if (!sessionsById.has(session.sessionId)) {
            sessionsById.set(session.sessionId, []);
        }
        sessionsById.get(session.sessionId).push(session);
    }

    let sessionsToScan = Array.from(sessionsById.values()).map(group => group[0]);

    if (Number.isFinite(maxSessions) && maxSessions > 0) {
        sessionsToScan = sessionsToScan.slice(0, maxSessions);
    }

    const sessionGroups = new Map();
    for (const session of sessionsToScan) {
        const group = sessionsById.get(session.sessionId) || [session];
        sessionGroups.set(session.sessionId, group);
    }

    results.summary.uniqueSessions = sessionsById.size;
    results.summary.sessionsScanned = sessionsToScan.length;
    results.summary.sessionsNotOnSale = sessionsNotOnSale.length;

    const scanCache = new Map();
    const concurrency = resolveConcurrency(sessionsToScan.length, { maxConcurrentSessions });
    logger.info('Using session scan concurrency', { concurrency, totalSessions: sessionsToScan.length });

    const scanResults = await scanSessionsInBatches(
        sessionsToScan,
        concurrency,
        delayMs,
        async (session, index, total) => {
            logger.info(`Scanning movie session ${index + 1}/${total}`, {
                sessionId: session.sessionId,
                movie: session.movie,
                time: session.time,
                date: session.date || session.dateText,
            });

            try {
                let cachedPromise = scanCache.get(session.sessionId);
                if (!cachedPromise) {
                    // Use retry wrapper for transient failures
                    cachedPromise = withRetry(
                        async () => {
                            const seatMap = await fetchSeatMap(session.sessionId, session.url, numSeats);
                            const optimalSeats = findOptimalSeats(seatMap, numSeats);
                            return { seatMap, optimalSeats };
                        },
                        {
                            shouldRetry: isRetryableError,
                            context: `fetchSeatMap(${session.sessionId})`,
                        }
                    );
                    scanCache.set(session.sessionId, cachedPromise);
                }

                const cached = await cachedPromise;

                const sessionResult = {
                    seatMap: {
                        totalSeats: cached.seatMap.totalSeats,
                        availableSeats: cached.seatMap.availableSeats,
                        soldSeats: cached.seatMap.soldSeats,
                        totalRows: cached.seatMap.totalRows,
                    },
                    optimalGroups: cached.optimalSeats.filter(g => g.isOptimal),
                    availableGroups: cached.optimalSeats.filter(g => !g.isOptimal),
                    hasOptimal: cached.optimalSeats.some(g => g.isOptimal),
                    hasAvailable: cached.optimalSeats.length > 0,
                };

                const group = sessionGroups.get(session.sessionId) || [session];
                const sessionResults = (!matchesOnly || sessionResult.hasOptimal) ?
                    group.map(entry => ({ ...entry, ...sessionResult })) :
                    null;

                return {
                    sessionResults,
                    hasOptimal: sessionResult.hasOptimal,
                    hasAvailable: sessionResult.hasAvailable,
                };
            } catch (error) {
                logger.error('Error scanning movie session (after retries)', {
                    sessionId: session.sessionId,
                    error: error.message,
                });

                const group = sessionGroups.get(session.sessionId) || [session];
                const sessionResults = !matchesOnly ? group.map(entry => ({
                    ...entry,
                    error: error.message,
                    hasOptimal: false,
                    hasAvailable: false,
                })) : null;

                return {
                    sessionResults,
                    hasOptimal: false,
                    hasAvailable: false,
                };
            }
        },
        { onProgress }
    );

    for (const result of scanResults) {
        if (result.hasOptimal) {
            results.summary.sessionsWithOptimal++;
        }
        if (result.hasAvailable) {
            results.summary.sessionsWithAvailable++;
        }
        if (result.sessionResults) {
            results.sessions.push(...result.sessionResults);
        }
    }

    logger.info('IMAX movie scan complete', {
        movieId,
        totalSessions: results.summary.totalSessions,
        uniqueSessions: results.summary.uniqueSessions,
        sessionsScanned: results.summary.sessionsScanned,
        sessionsReturned: results.sessions.length,
        withOptimal: results.summary.sessionsWithOptimal,
    });

    return results;
}

/**
 * Quick scan to just get session list without seat maps
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Promise<Array>}
 */
async function quickScanSessions(date) {
    return fetchImaxSessions(date);
}

module.exports = {
    IMAX_CONFIG,
    fetchImaxSessions,
    fetchImaxMovieSessions,
    fetchImaxMoviesWithSessions,
    fetchSeatMap,
    processSeatLayout,
    findOptimalSeats,
    findConsecutiveSeats,
    scanImaxDate,
    scanImaxMovie,
    quickScanSessions,
    // Shared helpers for Vista ticketing
    selectTicketsOnPage,
    clickNextButton,
};
