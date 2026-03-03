const DEPRECATED_ENV_VARS = Object.freeze([
    {
        name: 'YTDLP_COOKIES_FILE',
        replacement: 'YTDLP_COOKIES_PATH',
        note: 'Use a single canonical cookies path variable.',
    },
    {
        name: 'YTDLP_COOKIES',
        replacement: 'YTDLP_COOKIES_PATH',
        note: 'Use a single canonical cookies path variable.',
    },
    {
        name: 'YTDLP_CONFIG',
        replacement: 'YTDLP_CONFIG_PATH',
        note: 'Use a single canonical config path variable.',
    },
    {
        name: 'YTDLP_JS_RUNTIMES',
        replacement: 'YTDLP_JS_RUNTIME',
        note: 'Use one runtime selector variable.',
    },
    {
        name: 'DISABLE_DIRECT_URL',
        replacement: 'MUSIC_STREAM_MODE=ytdlp',
        note: 'Legacy stream mode flag was removed.',
    },
    {
        name: 'PREFER_YTDLP_STREAMING',
        replacement: 'MUSIC_STREAM_MODE=ytdlp',
        note: 'Legacy stream mode flag was removed.',
    },
    {
        name: 'YTDLP_DIRECT_WAIT_MS',
        replacement: '(remove)',
        note: 'Direct wait tuning is no longer used.',
    },
]);

function isDefined(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
}

function collectDeprecatedEnvUsage() {
    return DEPRECATED_ENV_VARS.filter(({ name }) => isDefined(process.env[name]));
}

function logDeprecatedEnvUsage(logger) {
    const deprecated = collectDeprecatedEnvUsage();
    if (deprecated.length === 0) return;
    for (const { name, replacement, note } of deprecated) {
        logger.warn(
            `Deprecated env var detected: ${name}. ` +
            `Replacement: ${replacement}. ${note}`
        );
    }
}

module.exports = {
    DEPRECATED_ENV_VARS,
    collectDeprecatedEnvUsage,
    logDeprecatedEnvUsage,
};
