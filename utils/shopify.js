const logger = require('../logger').child('shopify');

function buildVariantTitle(variant) {
    const parts = [variant.option1, variant.option2, variant.option3]
        .filter(o => o && o !== 'Default Title' && o !== '-');
    return parts.join(' / ') || 'Default';
}

async function fetchShopifyProduct(productUrl) {
    let url;
    try {
        url = new URL(productUrl);
    } catch {
        throw new Error('Invalid URL');
    }

    if (!url.pathname.includes('/products/')) {
        throw new Error('Not a valid Shopify product URL');
    }

    const jsonUrl = `${url.origin}${url.pathname}.json`;
    let data;
    try {
        const response = await fetch(jsonUrl);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        data = await response.json();
    } catch (error) {
        logger.error('Shopify fetch error', { error: error.message, url: jsonUrl });
        throw new Error('Failed to fetch product data');
    }

    const product = data.product;
    if (!product || !Array.isArray(product.variants)) {
        throw new Error('No product data found');
    }

    const variants = product.variants.map(variant => ({
        id: variant.id,
        title: buildVariantTitle(variant),
        price: variant.price,
        compareAtPrice: variant.compare_at_price,
        stock: variant.inventory_quantity,
        available: variant.available,
        addToCart: `${url.origin}/cart/${variant.id}:1`,
    }));

    return {
        url,
        product,
        title: product.title,
        vendor: product.vendor,
        productType: product.product_type,
        image: product.images?.[0]?.src,
        variants,
    };
}

module.exports = {
    fetchShopifyProduct,
};
