// Enhanced logger for Docker/Unraid with structured logging
// Configuration via environment variables:
// LOG_DIR (default 'logs'), LOG_MAX_SIZE_MB (default 5), LOG_MAX_FILES (default 5)
// LOG_LEVEL (default 'info') - debug, info, warn, error
// LOG_FORMAT (default 'text') - text, json
// LOG_COLORS (default 'true') - enable/disable console colors

const fs = require('fs');
const path = require('path');

// Configuration
const LOG_DIR = process.env.LOG_DIR || 'logs';
const MAX_SIZE = (parseInt(process.env.LOG_MAX_SIZE_MB, 10) || 5) * 1024 * 1024;
const MAX_FILES = parseInt(process.env.LOG_MAX_FILES, 10) || 5;
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_FORMAT = (process.env.LOG_FORMAT || 'text').toLowerCase();
const LOG_COLORS = process.env.LOG_COLORS !== 'false';

// Log levels (lower = more verbose)
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LEVELS[LOG_LEVEL] ?? 1;

// ANSI colors for console
const COLORS = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    magenta: '\x1b[35m',
};

const LEVEL_COLORS = {
    debug: COLORS.dim,
    info: COLORS.blue,
    warn: COLORS.yellow,
    error: COLORS.red,
};

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}
const BASE = path.join(LOG_DIR, 'packbot.log');

// Rotate log files if needed
function rotateIfNeeded() {
    try {
        if (!fs.existsSync(BASE)) return;
        const { size } = fs.statSync(BASE);
        if (size < MAX_SIZE) return;

        const files = fs.readdirSync(LOG_DIR)
            .filter(f => f.startsWith('packbot.log.'))
            .sort();

        while (files.length >= (MAX_FILES - 1)) {
            const old = files.shift();
            try { fs.unlinkSync(path.join(LOG_DIR, old)); } catch { /* ignore */ }
        }

        const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
        fs.renameSync(BASE, path.join(LOG_DIR, `packbot.log.${stamp}`));
    } catch { /* ignore rotation errors */ }
}

// Format timestamp
function timestamp() {
    return new Date().toISOString();
}

// Format for file (always structured text)
function formatFile(level, component, msg, meta) {
    const ts = timestamp();
    const comp = component ? `[${component}] ` : '';
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${ts}] [${level.toUpperCase()}] ${comp}${msg}${metaStr}\n`;
}

// Format for console
function formatConsole(level, component, msg, meta) {
    const ts = timestamp();
    
    if (LOG_FORMAT === 'json') {
        // JSON format for container log aggregation
        const logObj = {
            timestamp: ts,
            level: level.toUpperCase(),
            component: component || 'app',
            message: msg,
            ...meta
        };
        return JSON.stringify(logObj);
    }
    
    // Text format with optional colors
    if (LOG_COLORS && process.stdout.isTTY) {
        const levelColor = LEVEL_COLORS[level] || '';
        const compStr = component ? `${COLORS.cyan}[${component}]${COLORS.reset} ` : '';
        const metaStr = meta ? ` ${COLORS.dim}${JSON.stringify(meta)}${COLORS.reset}` : '';
        return `${COLORS.dim}[${ts}]${COLORS.reset} ${levelColor}[${level.toUpperCase()}]${COLORS.reset} ${compStr}${msg}${metaStr}`;
    }
    
    // Plain text (Docker default - no TTY)
    const comp = component ? `[${component}] ` : '';
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${ts}] [${level.toUpperCase()}] ${comp}${msg}${metaStr}`;
}

// Duplicate suppression
const recent = new Map();
const DEDUP_WINDOW_MS = 10_000;

function write(level, component, msg, meta) {
    if (LEVELS[level] < CURRENT_LEVEL) return;
    
    rotateIfNeeded();
    
    const key = `${level}|${component || ''}|${msg}`;
    const now = Date.now();
    const entry = recent.get(key);
    
    if (entry && now - entry.lastTs < DEDUP_WINDOW_MS) {
        entry.count++;
        entry.lastTs = now;
        return;
    }
    
    if (entry && entry.count > 1) {
        const repeatMsg = `${msg} (repeated ${entry.count}x)`;
        try { fs.appendFileSync(BASE, formatFile(level, component, repeatMsg, meta)); } catch {}
        recent.delete(key);
    }
    
    recent.set(key, { count: 1, lastTs: now });
    
    // Write to file
    try { fs.appendFileSync(BASE, formatFile(level, component, msg, meta)); } catch {}
    
    // Write to console
    const consoleMsg = formatConsole(level, component, msg, meta);
    if (level === 'error') {
        console.error(consoleMsg);
    } else if (level === 'warn') {
        console.warn(consoleMsg);
    } else {
        console.log(consoleMsg);
    }
}

// Periodic flush of dedup map
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of recent) {
        if (now - entry.lastTs >= DEDUP_WINDOW_MS) {
            if (entry.count > 1) {
                const parts = key.split('|');
                const level = parts[0];
                const component = parts[1] || null;
                const msg = parts.slice(2).join('|');
                try { 
                    fs.appendFileSync(BASE, formatFile(level, component, `${msg} (repeated ${entry.count}x)`, null)); 
                } catch {}
            }
            recent.delete(key);
        }
    }
}, 5000).unref();

// Create a child logger with a component name
function createLogger(component) {
    return {
        debug: (msg, meta) => write('debug', component, msg, meta),
        info: (msg, meta) => write('info', component, msg, meta),
        warn: (msg, meta) => write('warn', component, msg, meta),
        error: (msg, meta) => write('error', component, msg, meta),
        child: (subComponent) => createLogger(component ? `${component}:${subComponent}` : subComponent),
        command: (name, user, guild) => write('info', component || 'commands', `/${name}`, { user, guild }),
    };
}

// Default logger (backward compatible)
module.exports = {
    debug: (msg, meta) => write('debug', null, msg, meta),
    info: (msg, meta) => write('info', null, msg, meta),
    warn: (msg, meta) => write('warn', null, msg, meta),
    error: (msg, meta) => write('error', null, msg, meta),
    child: createLogger,
    command: (name, user, guild) => write('info', 'commands', `/${name}`, { user, guild }),
};
