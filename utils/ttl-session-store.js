const session = require('express-session');

function parseExpiry(sessionData, defaultTtlMs) {
    const expires = sessionData?.cookie?.expires;
    if (expires) {
        const ts = new Date(expires).getTime();
        if (Number.isFinite(ts)) return ts;
    }
    const maxAge = Number(sessionData?.cookie?.maxAge);
    if (Number.isFinite(maxAge) && maxAge > 0) {
        return Date.now() + maxAge;
    }
    return Date.now() + defaultTtlMs;
}

class TTLSessionStore extends session.Store {
    constructor(options = {}) {
        super();
        this.defaultTtlMs = options.defaultTtlMs || 7 * 24 * 60 * 60 * 1000;
        this.cleanupIntervalMs = options.cleanupIntervalMs || 10 * 60 * 1000;
        this.sessions = new Map();
        this.cleanupTimer = setInterval(() => this.cleanupExpired(), this.cleanupIntervalMs);
        if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
    }

    get(sid, callback) {
        const row = this.sessions.get(sid);
        if (!row) return callback(null, null);
        if (row.expiresAt <= Date.now()) {
            this.sessions.delete(sid);
            return callback(null, null);
        }
        return callback(null, row.session);
    }

    set(sid, sessionData, callback = () => {}) {
        this.sessions.set(sid, {
            session: sessionData,
            expiresAt: parseExpiry(sessionData, this.defaultTtlMs),
        });
        callback(null);
    }

    destroy(sid, callback = () => {}) {
        this.sessions.delete(sid);
        callback(null);
    }

    touch(sid, sessionData, callback = () => {}) {
        const row = this.sessions.get(sid);
        if (!row) return callback(null);
        row.expiresAt = parseExpiry(sessionData, this.defaultTtlMs);
        row.session = sessionData;
        this.sessions.set(sid, row);
        callback(null);
    }

    cleanupExpired() {
        const now = Date.now();
        for (const [sid, row] of this.sessions.entries()) {
            if (row.expiresAt <= now) this.sessions.delete(sid);
        }
    }
}

module.exports = TTLSessionStore;
