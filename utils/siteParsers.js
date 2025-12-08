/**
 * Site-specific parsers for different e-commerce and ticketing platforms
 * Each parser extracts structured data that can be compared for changes
 */

const logger = require('../logger').child('site-parsers');
const { HttpClient } = require('./httpClient');

const httpClient = new HttpClient({ timeout: 20000, retries: 2 });

// ============================================
// SITE TYPE DETECTION
// ============================================

/**
 * Detect the site type from a URL
 * @param {string} url 
 * @returns {'shopify'|'ticketmaster'|'ticketek'|'axs'|'eventbrite'|'generic'}
 */
function detectSiteType(url) {
    const hostname = new URL(url).hostname.toLowerCase();
    const pathname = new URL(url).pathname.toLowerCase();

    // Shopify detection - product pages or known Shopify stores
    if (pathname.includes('/products/') || pathname.includes('/collections/')) {
        return 'shopify';
    }

    // Ticketmaster / Live Nation
    if (hostname.includes('ticketmaster.') || hostname.includes('livenation.')) {
        return 'ticketmaster';
    }

    // Ticketek (Australia/NZ)
    if (hostname.includes('ticketek.com') || hostname.includes('premier.ticketek.')) {
        return 'ticketek';
    }

    // AXS
    if (hostname.includes('axs.com')) {
        return 'axs';
    }

    // Eventbrite
    if (hostname.includes('eventbrite.')) {
        return 'eventbrite';
    }

    // Moshtix
    if (hostname.includes('moshtix.com')) {
        return 'moshtix';
    }

    // Try to detect Shopify by checking for common patterns
    if (hostname.includes('myshopify.com')) {
        return 'shopify';
    }

    return 'generic';
}

// ============================================
// SHOPIFY PARSER
// ============================================

/**
 * Parse Shopify product data
 * @param {string} url - Product URL
 * @returns {Promise<object>} Parsed product data
 */
async function parseShopify(url) {
    const parsedUrl = new URL(url);
    
    // Try to fetch the .json endpoint
    let jsonUrl = `${parsedUrl.origin}${parsedUrl.pathname}`;
    if (!jsonUrl.endsWith('.json')) {
        jsonUrl = jsonUrl.replace(/\/$/, '') + '.json';
    }

    try {
        const data = await httpClient.getJson(jsonUrl);
        const product = data.product;

        if (!product) {
            throw new Error('No product data found');
        }

        // Calculate total stock
        const totalStock = product.variants?.reduce((sum, v) => {
            return sum + (v.inventory_quantity || 0);
        }, 0) || 0;

        // Find price range
        const prices = product.variants?.map(v => parseFloat(v.price)) || [];
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);

        return {
            type: 'shopify',
            success: true,
            title: product.title,
            vendor: product.vendor,
            productType: product.product_type,
            handle: product.handle,
            image: product.images?.[0]?.src,
            totalStock,
            available: product.variants?.some(v => v.available) || false,
            priceRange: { min: minPrice, max: maxPrice },
            variants: product.variants?.map(v => ({
                id: v.id,
                title: [v.option1, v.option2, v.option3]
                    .filter(o => o && o !== 'Default Title' && o !== '-')
                    .join(' / ') || 'Default',
                price: parseFloat(v.price),
                compareAtPrice: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
                stock: v.inventory_quantity,
                available: v.available,
                sku: v.sku,
            })) || [],
            // For change detection
            _hash: generateShopifyHash(product),
        };
    } catch (error) {
        // Fallback: try scraping the HTML page
        return parseShopifyHtml(url);
    }
}

/**
 * Fallback HTML scraping for Shopify when JSON isn't available
 */
async function parseShopifyHtml(url) {
    const html = await httpClient.getText(url);
    
    // Try to find product JSON in the page
    const jsonMatch = html.match(/var\s+meta\s*=\s*({[\s\S]*?"product"[\s\S]*?});/);
    if (jsonMatch) {
        try {
            const meta = JSON.parse(jsonMatch[1]);
            if (meta.product) {
                return {
                    type: 'shopify',
                    success: true,
                    title: meta.product.title,
                    vendor: meta.product.vendor,
                    available: meta.product.available,
                    variants: meta.product.variants?.map(v => ({
                        id: v.id,
                        title: v.title,
                        price: v.price / 100, // Often in cents
                        available: v.available,
                    })) || [],
                    _hash: JSON.stringify(meta.product),
                };
            }
        } catch {}
    }

    // Extract basic info from HTML
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const priceMatch = html.match(/\$[\d,]+\.?\d*/);
    const soldOutMatch = /sold\s*out|out\s*of\s*stock|unavailable/i.test(html);

    return {
        type: 'shopify',
        success: true,
        title: titleMatch?.[1]?.trim() || 'Unknown Product',
        available: !soldOutMatch,
        price: priceMatch?.[0],
        _hash: html.length.toString(), // Basic hash
    };
}

/**
 * Generate a hash for Shopify product change detection
 */
function generateShopifyHash(product) {
    const key = {
        title: product.title,
        variants: product.variants?.map(v => ({
            id: v.id,
            price: v.price,
            stock: v.inventory_quantity,
            available: v.available,
        })),
    };
    return JSON.stringify(key);
}

// ============================================
// TICKETMASTER PARSER
// ============================================

/**
 * Parse Ticketmaster event page
 * @param {string} url - Event URL
 * @returns {Promise<object>} Parsed event data
 */
async function parseTicketmaster(url) {
    const html = await httpClient.getText(url);
    
    // Try to find event JSON data embedded in the page
    const ldJsonMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi) || [];
    let eventData = null;

    for (const match of ldJsonMatches) {
        try {
            const jsonStr = match.replace(/<script[^>]*>|<\/script>/gi, '');
            const data = JSON.parse(jsonStr);
            if (data['@type'] === 'Event' || data['@type'] === 'MusicEvent') {
                eventData = data;
                break;
            }
        } catch {}
    }

    // Extract availability signals
    const soldOut = /sold\s*out|no\s*tickets|unavailable|off\s*sale/i.test(html);
    const onSale = /on\s*sale|buy\s*tickets|get\s*tickets|available/i.test(html);
    const presale = /presale|pre-sale|early\s*access/i.test(html);
    const waitlist = /waitlist|wait\s*list|notify\s*me/i.test(html);

    // Try to extract price range
    const priceMatch = html.match(/\$[\d,]+(?:\.\d{2})?(?:\s*-\s*\$[\d,]+(?:\.\d{2})?)?/);
    
    // Extract title
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);

    return {
        type: 'ticketmaster',
        success: true,
        title: eventData?.name || h1Match?.[1]?.trim() || titleMatch?.[1]?.trim() || 'Unknown Event',
        venue: eventData?.location?.name,
        date: eventData?.startDate,
        image: eventData?.image,
        priceRange: priceMatch?.[0] || null,
        status: {
            soldOut,
            onSale: onSale && !soldOut,
            presale,
            waitlist,
        },
        available: onSale && !soldOut,
        url: eventData?.url || url,
        _hash: JSON.stringify({ soldOut, onSale, presale, waitlist }),
    };
}

// ============================================
// TICKETEK PARSER
// ============================================

/**
 * Parse Ticketek event page (Australian ticketing)
 * @param {string} url - Event URL
 * @returns {Promise<object>} Parsed event data
 */
async function parseTicketek(url) {
    const html = await httpClient.getText(url);
    
    // Ticketek uses various structures
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);

    // Check availability signals
    const soldOut = /sold\s*out|not\s*available|no\s*tickets/i.test(html);
    const onSale = /buy\s*tickets|on\s*sale|get\s*tickets|book\s*now/i.test(html);
    const comingSoon = /coming\s*soon|announced|on\s*sale\s*soon/i.test(html);
    const presale = /presale|pre-sale|member\s*pre/i.test(html);

    // Try to find event data
    const dateMatch = html.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{4})/i);
    const venueMatch = html.match(/venue[:\s]*([^<\n]+)/i);
    const priceMatch = html.match(/\$[\d,]+(?:\.\d{2})?/);

    return {
        type: 'ticketek',
        success: true,
        title: h1Match?.[1]?.trim() || titleMatch?.[1]?.replace(/\s*[|\-].*$/, '').trim() || 'Unknown Event',
        venue: venueMatch?.[1]?.trim(),
        date: dateMatch ? `${dateMatch[1]} ${dateMatch[2]} ${dateMatch[3]}` : null,
        priceRange: priceMatch?.[0] || null,
        status: {
            soldOut,
            onSale: onSale && !soldOut,
            comingSoon,
            presale,
        },
        available: onSale && !soldOut,
        _hash: JSON.stringify({ soldOut, onSale, comingSoon, presale }),
    };
}

// ============================================
// AXS PARSER
// ============================================

/**
 * Parse AXS event page
 * @param {string} url - Event URL
 * @returns {Promise<object>} Parsed event data
 */
async function parseAXS(url) {
    const html = await httpClient.getText(url);

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);

    // AXS availability signals
    const soldOut = /sold\s*out|no\s*tickets|currently\s*unavailable/i.test(html);
    const onSale = /buy\s*tickets|get\s*tickets|on\s*sale/i.test(html);
    const presale = /presale|pre-sale/i.test(html);

    // Try to find JSON-LD
    const ldJsonMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    let eventData = null;
    if (ldJsonMatch) {
        try {
            eventData = JSON.parse(ldJsonMatch[1]);
        } catch {}
    }

    return {
        type: 'axs',
        success: true,
        title: eventData?.name || h1Match?.[1]?.trim() || titleMatch?.[1]?.trim() || 'Unknown Event',
        venue: eventData?.location?.name,
        date: eventData?.startDate,
        status: {
            soldOut,
            onSale: onSale && !soldOut,
            presale,
        },
        available: onSale && !soldOut,
        _hash: JSON.stringify({ soldOut, onSale, presale }),
    };
}

// ============================================
// EVENTBRITE PARSER
// ============================================

/**
 * Parse Eventbrite event page
 * @param {string} url - Event URL
 * @returns {Promise<object>} Parsed event data
 */
async function parseEventbrite(url) {
    const html = await httpClient.getText(url);

    // Eventbrite embeds a lot of data in JSON-LD
    const ldJsonMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi) || [];
    let eventData = null;

    for (const match of ldJsonMatches) {
        try {
            const jsonStr = match.replace(/<script[^>]*>|<\/script>/gi, '');
            const data = JSON.parse(jsonStr);
            if (data['@type'] === 'Event') {
                eventData = data;
                break;
            }
        } catch {}
    }

    const soldOut = /sold\s*out|sales\s*ended|registration\s*closed/i.test(html);
    const onSale = /register|get\s*tickets|buy\s*tickets/i.test(html);
    const free = /free|no\s*charge|\$0/i.test(html);

    return {
        type: 'eventbrite',
        success: true,
        title: eventData?.name || 'Unknown Event',
        venue: eventData?.location?.name,
        date: eventData?.startDate,
        image: eventData?.image,
        organizer: eventData?.organizer?.name,
        status: {
            soldOut,
            onSale: onSale && !soldOut,
            free,
        },
        available: onSale && !soldOut,
        offers: eventData?.offers,
        _hash: JSON.stringify({ soldOut, onSale, free }),
    };
}

// ============================================
// GENERIC PARSER
// ============================================

/**
 * Generic page parser for any website
 * @param {string} url - Page URL
 * @param {string[]} keywords - Keywords to look for
 * @returns {Promise<object>} Parsed page data
 */
async function parseGeneric(url, keywords = []) {
    const html = await httpClient.getText(url);
    
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    
    // Check for common availability keywords
    const soldOut = /sold\s*out|out\s*of\s*stock|unavailable|no\s*longer\s*available/i.test(html);
    const available = /in\s*stock|available|add\s*to\s*cart|buy\s*now/i.test(html);
    const comingSoon = /coming\s*soon|notify\s*me|pre-?order/i.test(html);

    // Check for user-specified keywords
    const keywordMatches = {};
    const lowerHtml = html.toLowerCase();
    for (const kw of keywords) {
        keywordMatches[kw] = lowerHtml.includes(kw.toLowerCase());
    }

    // Extract any prices found
    const priceMatches = html.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
    const prices = [...new Set(priceMatches)].slice(0, 5); // Unique, max 5

    // Create content hash for change detection
    const crypto = require('crypto');
    const contentHash = crypto.createHash('md5').update(html).digest('hex');

    return {
        type: 'generic',
        success: true,
        title: h1Match?.[1]?.trim() || titleMatch?.[1]?.trim() || 'Unknown Page',
        status: {
            soldOut,
            available: available && !soldOut,
            comingSoon,
        },
        available: available && !soldOut,
        prices,
        keywordMatches,
        contentLength: html.length,
        _hash: contentHash,
        _rawHtml: html, // For keyword checking
    };
}

// ============================================
// MAIN PARSER FUNCTION
// ============================================

/**
 * Parse a URL using the appropriate site-specific parser
 * @param {string} url - URL to parse
 * @param {object} options - Parser options
 * @returns {Promise<object>} Parsed data
 */
async function parseSite(url, options = {}) {
    const { type, keywords = [] } = options;
    
    // Auto-detect site type if not specified
    const siteType = type || detectSiteType(url);
    
    logger.debug(`Parsing ${url} as ${siteType}`);

    try {
        switch (siteType) {
            case 'shopify':
                return await parseShopify(url);
            case 'ticketmaster':
                return await parseTicketmaster(url);
            case 'ticketek':
                return await parseTicketek(url);
            case 'axs':
                return await parseAXS(url);
            case 'eventbrite':
                return await parseEventbrite(url);
            case 'generic':
            default:
                return await parseGeneric(url, keywords);
        }
    } catch (error) {
        logger.error(`Failed to parse ${url}`, { error: error.message, siteType });
        return {
            type: siteType,
            success: false,
            error: error.message,
        };
    }
}

// ============================================
// CHANGE DETECTION HELPERS
// ============================================

/**
 * Compare two parsed results and detect changes
 * @param {object} oldData - Previous parsed data
 * @param {object} newData - Current parsed data
 * @returns {object} Change details
 */
function detectChanges(oldData, newData) {
    if (!oldData || !newData) {
        return { hasChanges: false, changes: [] };
    }

    const changes = [];
    const type = newData.type;

    // Type-specific change detection
    if (type === 'shopify') {
        // Stock changes
        if (oldData.totalStock !== newData.totalStock) {
            changes.push({
                type: 'stock',
                field: 'totalStock',
                old: oldData.totalStock,
                new: newData.totalStock,
                message: `Stock changed: ${oldData.totalStock} → ${newData.totalStock}`,
            });
        }

        // Availability change
        if (oldData.available !== newData.available) {
            changes.push({
                type: 'availability',
                field: 'available',
                old: oldData.available,
                new: newData.available,
                message: newData.available ? '✅ Now AVAILABLE!' : '❌ Now SOLD OUT',
            });
        }

        // Price changes
        if (oldData.priceRange?.min !== newData.priceRange?.min) {
            const direction = newData.priceRange?.min < oldData.priceRange?.min ? '📉 PRICE DROP' : '📈 Price increase';
            changes.push({
                type: 'price',
                field: 'price',
                old: oldData.priceRange?.min,
                new: newData.priceRange?.min,
                message: `${direction}: $${oldData.priceRange?.min} → $${newData.priceRange?.min}`,
            });
        }

        // Per-variant changes
        if (oldData.variants && newData.variants) {
            const oldVariants = new Map(oldData.variants.map(v => [v.id, v]));
            for (const newV of newData.variants) {
                const oldV = oldVariants.get(newV.id);
                if (oldV) {
                    // Variant came back in stock
                    if (!oldV.available && newV.available) {
                        changes.push({
                            type: 'variant_restock',
                            field: `variant_${newV.id}`,
                            old: false,
                            new: true,
                            message: `🔔 "${newV.title}" is back in stock!`,
                        });
                    }
                    // Variant went out of stock
                    if (oldV.available && !newV.available) {
                        changes.push({
                            type: 'variant_oos',
                            field: `variant_${newV.id}`,
                            old: true,
                            new: false,
                            message: `"${newV.title}" is now sold out`,
                        });
                    }
                } else {
                    // New variant added
                    changes.push({
                        type: 'new_variant',
                        field: `variant_${newV.id}`,
                        new: newV,
                        message: `🆕 New variant: "${newV.title}"`,
                    });
                }
            }
        }
    } else if (type === 'ticketmaster' || type === 'ticketek' || type === 'axs' || type === 'eventbrite') {
        // Ticket availability changes
        if (oldData.status?.soldOut !== newData.status?.soldOut) {
            if (!newData.status?.soldOut && oldData.status?.soldOut) {
                changes.push({
                    type: 'tickets_available',
                    field: 'soldOut',
                    old: true,
                    new: false,
                    message: '🎟️ TICKETS NOW AVAILABLE!',
                });
            } else {
                changes.push({
                    type: 'sold_out',
                    field: 'soldOut',
                    old: false,
                    new: true,
                    message: '❌ Event is now SOLD OUT',
                });
            }
        }

        // On-sale status change
        if (oldData.status?.onSale !== newData.status?.onSale && newData.status?.onSale) {
            changes.push({
                type: 'on_sale',
                field: 'onSale',
                old: false,
                new: true,
                message: '🎉 TICKETS NOW ON SALE!',
            });
        }

        // Presale started
        if (!oldData.status?.presale && newData.status?.presale) {
            changes.push({
                type: 'presale',
                field: 'presale',
                old: false,
                new: true,
                message: '⭐ PRESALE NOW ACTIVE!',
            });
        }
    } else {
        // Generic: just check if hash changed
        if (oldData._hash !== newData._hash) {
            changes.push({
                type: 'content',
                field: 'content',
                message: 'Page content has changed',
            });
        }

        // Check keyword appearances
        if (newData.keywordMatches) {
            for (const [kw, found] of Object.entries(newData.keywordMatches)) {
                const wasFound = oldData.keywordMatches?.[kw] || false;
                if (!wasFound && found) {
                    changes.push({
                        type: 'keyword_appeared',
                        field: `keyword_${kw}`,
                        keyword: kw,
                        message: `🔑 Keyword "${kw}" appeared on page!`,
                    });
                }
            }
        }
    }

    return {
        hasChanges: changes.length > 0,
        changes,
        summary: changes.map(c => c.message).join('\n'),
    };
}

/**
 * Get supported site types
 */
function getSupportedSiteTypes() {
    return [
        { id: 'auto', name: 'Auto-detect', description: 'Automatically detect site type' },
        { id: 'shopify', name: 'Shopify', description: 'Shopify product pages - tracks stock, price, variants' },
        { id: 'ticketmaster', name: 'Ticketmaster', description: 'Ticketmaster/Live Nation events' },
        { id: 'ticketek', name: 'Ticketek', description: 'Ticketek events (AU/NZ)' },
        { id: 'axs', name: 'AXS', description: 'AXS ticketing events' },
        { id: 'eventbrite', name: 'Eventbrite', description: 'Eventbrite events' },
        { id: 'generic', name: 'Generic', description: 'Any webpage - keyword/content monitoring' },
    ];
}

module.exports = {
    detectSiteType,
    parseSite,
    parseShopify,
    parseTicketmaster,
    parseTicketek,
    parseAXS,
    parseEventbrite,
    parseGeneric,
    detectChanges,
    getSupportedSiteTypes,
};
