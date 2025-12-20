/**
 * IMAX Melbourne Auto-Checkout Utility
 * Handles Big League login and seat selection pre-fill
 */

const crypto = require('crypto');
const logger = require('../logger').child('imax-checkout');
const db = require('../database/db');
const { getBrowserClient } = require('./browserClient');
const { isQueueItUrl } = require('./queueitDetector');
const { selectTicketsOnPage, clickNextButton } = require('./imaxParser');

// Encryption key from environment - MUST be set in production
const ENCRYPTION_KEY = process.env.IMAX_ENCRYPTION_KEY;
const ALGORITHM = 'aes-256-cbc';

// Validate encryption key on module load
if (!ENCRYPTION_KEY) {
    logger.error('IMAX_ENCRYPTION_KEY environment variable is not set. Credential storage will fail.');
}

/**
 * Encrypt a string using AES-256-CBC with unique salt
 * @param {string} text - Text to encrypt
 * @returns {string} - Encrypted text (salt:iv:encrypted)
 */
function encrypt(text) {
    if (!ENCRYPTION_KEY) {
        throw new Error('IMAX_ENCRYPTION_KEY is not configured. Cannot encrypt credentials.');
    }
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(ENCRYPTION_KEY, salt, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${salt.toString('hex')}:${iv.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a string encrypted with encrypt()
 * @param {string} encryptedText - Text to decrypt (salt:iv:encrypted or legacy iv:encrypted format)
 * @returns {string} - Decrypted text
 */
function decrypt(encryptedText) {
    if (!ENCRYPTION_KEY) {
        throw new Error('IMAX_ENCRYPTION_KEY is not configured. Cannot decrypt credentials.');
    }
    const parts = encryptedText.split(':');

    let salt, iv, encrypted;
    if (parts.length === 3) {
        // New format: salt:iv:encrypted
        salt = Buffer.from(parts[0], 'hex');
        iv = Buffer.from(parts[1], 'hex');
        encrypted = parts[2];
    } else if (parts.length === 2) {
        // Legacy format: iv:encrypted (static salt)
        salt = Buffer.from('salt');
        iv = Buffer.from(parts[0], 'hex');
        encrypted = parts[1];
    } else {
        throw new Error('Invalid encrypted data format');
    }

    const key = crypto.scryptSync(ENCRYPTION_KEY, salt, 32);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

/**
 * Store Big League credentials for a user
 * @param {string} userId - Discord user ID
 * @param {string} email - Big League email
 * @param {string} password - Big League password
 * @param {string} [memberNumber] - Optional member number
 */
async function storeCredentials(userId, email, password, memberNumber = null) {
    const encryptedPassword = encrypt(password);

    await db.pool.query(
        `INSERT INTO ImaxCredentials (odUserId, email, encryptedPassword, memberNumber)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
         email = VALUES(email),
         encryptedPassword = VALUES(encryptedPassword),
         memberNumber = VALUES(memberNumber),
         updatedAt = NOW()`,
        [userId, email, encryptedPassword, memberNumber]
    );

    logger.info('Stored IMAX credentials', { userId, email: email.replace(/(.{2}).*@/, '$1***@') });
}

/**
 * Get stored credentials for a user
 * @param {string} userId - Discord user ID
 * @returns {Promise<{email: string, password: string, memberNumber: string|null}|null>}
 */
async function getCredentials(userId) {
    const [rows] = await db.pool.query(
        'SELECT email, encryptedPassword, memberNumber FROM ImaxCredentials WHERE odUserId = ?',
        [userId]
    );

    if (rows.length === 0) {
        return null;
    }

    const { email, encryptedPassword, memberNumber } = rows[0];

    try {
        const password = decrypt(encryptedPassword);
        return { email, password, memberNumber };
    } catch (error) {
        logger.error('Failed to decrypt credentials', { userId, error: error.message });
        return null;
    }
}

/**
 * Delete stored credentials for a user
 * @param {string} userId - Discord user ID
 */
async function deleteCredentials(userId) {
    await db.pool.query('DELETE FROM ImaxCredentials WHERE odUserId = ?', [userId]);
    logger.info('Deleted IMAX credentials', { userId });
}

/**
 * Check if user has stored credentials
 * @param {string} userId - Discord user ID
 * @returns {Promise<boolean>}
 */
async function hasCredentials(userId) {
    const [rows] = await db.pool.query(
        'SELECT 1 FROM ImaxCredentials WHERE odUserId = ? LIMIT 1',
        [userId]
    );
    return rows.length > 0;
}

/**
 * Log a checkout attempt
 * @param {object} data - Checkout data
 */
async function logCheckout(data) {
    const { userId, sessionId, movieTitle, sessionDate, sessionTime, numSeats, selectedSeats, checkoutUrl, status, errorMessage } = data;

    await db.pool.query(
        `INSERT INTO ImaxCheckoutLog
         (odUserId, sessionId, movieTitle, sessionDate, sessionTime, numSeats, selectedSeats, checkoutUrl, status, errorMessage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, sessionId, movieTitle, sessionDate, sessionTime, numSeats, JSON.stringify(selectedSeats), checkoutUrl, status, errorMessage]
    );
}

/**
 * Pre-fill checkout with selected seats
 * @param {object} options - Checkout options
 * @returns {Promise<{success: boolean, checkoutUrl: string, error?: string}>}
 */
async function prefillCheckout(options) {
    const {
        userId,
        sessionId,
        sessionUrl,
        numSeats = 2,
        preferredSeats = null, // Array of seat objects from findOptimalSeats
        movieTitle = 'Unknown',
        sessionDate = null,
        sessionTime = null,
    } = options;

    logger.info('Starting prefill checkout', { userId, sessionId, numSeats });

    // Get credentials
    const credentials = await getCredentials(userId);
    if (!credentials) {
        return {
            success: false,
            error: 'No Big League credentials stored. Use /movie login to set up.',
        };
    }

    const browserClient = getBrowserClient();
    const browser = await browserClient.ensureBrowser();
    const page = await browser.newPage();

    try {
        await browserClient.applyStealthSettings(page);

        // Build the booking URL
        const url = sessionUrl || `https://ticketing.imaxmelbourne.com.au/Ticketing/visSelectTickets.aspx?cinemacode=0000000001&txtSessionId=${sessionId}&visLang=1`;

        logger.debug('Navigating to booking page', { url });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Handle Queue-it if present
        if (isQueueItUrl(page.url())) {
            logger.info('Queue-it detected, waiting...');
            const passed = await browserClient.waitForQueueIt(page);
            if (!passed) {
                throw new Error('Queue-it timeout');
            }
        }

        // Step 1: Login if there's a login link
        const needsLogin = await page.evaluate(() => {
            const loginLink = document.querySelector('a[href*="Login"], a[href*="login"], .login-link, #lnkLogin');
            return !!loginLink;
        });

        if (needsLogin) {
            logger.debug('Logging in to Big League');

            // Click login link
            await page.evaluate(() => {
                const loginLink = document.querySelector('a[href*="Login"], a[href*="login"], .login-link, #lnkLogin');
                if (loginLink) loginLink.click();
            });

            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 1000));

            // Fill login form
            const loginResult = await page.evaluate((email, password) => {
                // Try various email field selectors
                const emailField = document.querySelector(
                    '#txtEmail, input[name*="email"], input[type="email"], #Email, [data-field="email"]'
                );
                const passwordField = document.querySelector(
                    '#txtPassword, input[name*="password"], input[type="password"], #Password, [data-field="password"]'
                );

                if (!emailField || !passwordField) {
                    return { success: false, error: 'Could not find login form fields' };
                }

                emailField.value = email;
                emailField.dispatchEvent(new Event('change', { bubbles: true }));
                passwordField.value = password;
                passwordField.dispatchEvent(new Event('change', { bubbles: true }));

                // Find and click submit button
                const submitBtn = document.querySelector(
                    '#btnLogin, button[type="submit"], input[type="submit"], .login-button, #ibtnLogin'
                );
                if (submitBtn) {
                    submitBtn.click();
                    return { success: true };
                }

                // Try form submit as fallback
                const form = emailField.closest('form');
                if (form) {
                    form.submit();
                    return { success: true };
                }

                return { success: false, error: 'Could not find login button' };
            }, credentials.email, credentials.password);

            if (!loginResult.success) {
                throw new Error(loginResult.error || 'Login failed');
            }

            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 2000));

            // Check for login error
            const loginError = await page.evaluate(() => {
                const errorEl = document.querySelector('.error, .login-error, .validation-summary-errors, .field-validation-error');
                return errorEl?.textContent?.trim();
            });

            if (loginError) {
                throw new Error(`Login failed: ${loginError}`);
            }

            // Navigate back to the session if needed
            if (!page.url().includes('SessionId')) {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            }
        }

        // Step 2: Select tickets using shared helper
        logger.debug('Selecting tickets', { numSeats });
        await page.waitForSelector('input.quantity', { timeout: 10000 });

        const ticketSet = await selectTicketsOnPage(page, numSeats);
        if (!ticketSet.success) {
            throw new Error(ticketSet.error || 'Could not select tickets');
        }
        logger.debug('Tickets selected', { name: ticketSet.name });

        await new Promise(r => setTimeout(r, 1000));

        // Step 3: Click Next using shared helper
        const nextClicked = await clickNextButton(page);
        if (!nextClicked) {
            throw new Error('Could not proceed to seat selection');
        }

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));

        // Step 4: Select preferred seats if provided
        let selectedSeats = [];
        if (preferredSeats && preferredSeats.length > 0) {
            logger.debug('Selecting preferred seats', { seats: preferredSeats.map(s => `${s.row}${s.col}`) });

            // Wait for seat map to load
            await page.waitForSelector('img[data-row][data-col][data-type="Empty"]', { timeout: 15000 });

            // Select seats
            selectedSeats = await page.evaluate((seats) => {
                const selected = [];
                for (const seat of seats) {
                    // Find the seat by row name and column
                    const seatEl = document.querySelector(
                        `img[data-name="${seat.row}"][data-col="${seat.col}"][data-type="Empty"]`
                    );
                    if (seatEl) {
                        seatEl.click();
                        selected.push({ row: seat.row, col: seat.col });
                    }
                }
                return selected;
            }, preferredSeats.slice(0, numSeats));

            if (selectedSeats.length < numSeats) {
                logger.warn('Could not select all preferred seats', {
                    requested: numSeats,
                    selected: selectedSeats.length
                });
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        // Step 5: Click continue/next to go to checkout
        const checkoutUrl = await page.evaluate(() => {
            // Try to find and click the continue button
            const continueBtn = document.querySelector(
                '#ibtnContinue, #btnContinue, .continue-button, input[value*="Continue"], button:contains("Continue")'
            );
            if (continueBtn) {
                continueBtn.click();
            }
            return window.location.href;
        });

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));

        const finalUrl = page.url();

        // Log the checkout attempt
        await logCheckout({
            userId,
            sessionId,
            movieTitle,
            sessionDate,
            sessionTime,
            numSeats,
            selectedSeats,
            checkoutUrl: finalUrl,
            status: 'prefilled',
        });

        logger.info('Checkout pre-filled successfully', {
            userId,
            sessionId,
            selectedSeats: selectedSeats.length,
            finalUrl: finalUrl.substring(0, 100),
        });

        return {
            success: true,
            checkoutUrl: finalUrl,
            selectedSeats,
        };

    } catch (error) {
        logger.error('Checkout prefill failed', {
            userId,
            sessionId,
            error: error.message,
        });

        // Log the failure
        await logCheckout({
            userId,
            sessionId,
            movieTitle,
            sessionDate,
            sessionTime,
            numSeats,
            selectedSeats: null,
            checkoutUrl: null,
            status: 'failed',
            errorMessage: error.message,
        }).catch(() => {});

        return {
            success: false,
            error: error.message,
        };

    } finally {
        await page.close();
    }
}

module.exports = {
    storeCredentials,
    getCredentials,
    deleteCredentials,
    hasCredentials,
    prefillCheckout,
    logCheckout,
};
