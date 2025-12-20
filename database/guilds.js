const db = require('./db');
const logger = require('../logger').child('database-guilds');

const TABLE_INFO_TTL_MS = 10 * 60 * 1000; // 10 minutes
let cachedTableInfo = null;
let cachedAt = 0;

async function getGuildsTableInfo() {
    if (cachedTableInfo && (Date.now() - cachedAt) < TABLE_INFO_TTL_MS) {
        return cachedTableInfo;
    }

    try {
        const [rows] = await db.pool.query('SHOW COLUMNS FROM Guilds');
        const fields = rows.map(r => r.Field);
        const fieldSet = new Set(fields);

        const primaryKey = rows.find(r => r.Key === 'PRI')?.Field || null;

        cachedTableInfo = {
            fields: fieldSet,
            primaryKey,
            hasUpdatedAt: fieldSet.has('updatedAt'),
            hasCreatedAt: fieldSet.has('createdAt'),
        };
        cachedAt = Date.now();
    } catch (error) {
        logger.warn('Failed to inspect Guilds table, falling back to unordered selects', {
            error: error?.message || String(error),
        });
        cachedTableInfo = {
            fields: new Set(),
            primaryKey: null,
            hasUpdatedAt: false,
            hasCreatedAt: false,
        };
        cachedAt = Date.now();
    }

    return cachedTableInfo;
}

function buildGuildsOrderBy(tableInfo) {
    const parts = [];
    if (tableInfo.hasUpdatedAt) parts.push('updatedAt DESC');
    if (tableInfo.hasCreatedAt) parts.push('createdAt DESC');
    if (tableInfo.primaryKey) parts.push(`\`${tableInfo.primaryKey}\` DESC`);
    return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
}

async function ensureGuildRow(guildId) {
    try {
        await db.pool.query(
            `INSERT INTO Guilds (guildId)
             SELECT ?
             WHERE NOT EXISTS (
               SELECT 1 FROM Guilds WHERE guildId = ? LIMIT 1
             )`,
            [guildId, guildId]
        );
    } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') return;
        throw error;
    }
}

async function getGuildRow(guildId) {
    await ensureGuildRow(guildId);

    const tableInfo = await getGuildsTableInfo();
    const orderBy = buildGuildsOrderBy(tableInfo);

    const [rows] = await db.pool.query(
        `SELECT * FROM Guilds WHERE guildId = ?${orderBy} LIMIT 1`,
        [guildId]
    );

    if (!rows[0]) {
        logger.warn('Guild row missing after ensure', { guildId });
    }

    return rows[0] || null;
}

module.exports = {
    getGuildRow,
    ensureGuildRow,
};
