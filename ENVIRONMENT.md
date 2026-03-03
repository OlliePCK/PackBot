# Environment Contract

This file defines the canonical environment variables for PackBot.

## Required

- `TOKEN`
- `CLIENT_ID`
- `MYSQL_HOST`
- `MYSQL_PORT`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_DB`

## Core Optional

- `ENABLE_API`
- `API_PORT`
- `NODE_ENV`
- `CORS_ORIGIN`
- `SESSION_SECRET`
- `DISCORD_CLIENT_SECRET`
- `OAUTH_REDIRECT_URI`
- `FRONTEND_URL`
- `TZ`

## Feature Optional

- `YOUTUBE_API_KEY`
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `DEEPGRAM_API_KEY`
- `OPENAI_API_KEY`
- `PROXY_URL`

## Logging Optional

- `LOG_LEVEL`
- `LOG_FORMAT`
- `LOG_COLORS`
- `LOG_DIR`
- `LOG_MAX_SIZE_MB`
- `LOG_MAX_FILES`
- `LOG_MUSIC_TIMINGS`
- `LOG_YTDLP_TIMINGS`

## Music Optional (Canonical)

- `MUSIC_STREAM_MODE`
- `MUSIC_OPUS_PASSTHROUGH`
- `YTDLP_PATH`
- `YTDLP_CONFIG_PATH`
- `YTDLP_COOKIES_PATH`
- `YTDLP_RESOLVE_DIRECT_URL`
- `YT_SEARCH_PROVIDER`
- `YTDLP_DIRECT_FAST`
- `YTDLP_DIRECT_TIMEOUT_MS`
- `YTDLP_INFO_TIMEOUT_MS`
- `YTDLP_FORCE_IPV4`
- `YTDLP_EXTRACTOR_ARGS`
- `YTDLP_PREFETCH_BYTES`
- `YTDLP_JS_RUNTIME`
- `YTDLP_REMOTE_COMPONENTS`
- `YT_MAX_BACKOFF_MULTIPLIER`

## Deprecated and Removed

These are deprecated and ignored by current code. Startup logs warn if set.

- `YTDLP_COOKIES_FILE` -> use `YTDLP_COOKIES_PATH`
- `YTDLP_COOKIES` -> use `YTDLP_COOKIES_PATH`
- `YTDLP_CONFIG` -> use `YTDLP_CONFIG_PATH`
- `YTDLP_JS_RUNTIMES` -> use `YTDLP_JS_RUNTIME`
- `DISABLE_DIRECT_URL` -> use `MUSIC_STREAM_MODE=ytdlp`
- `PREFER_YTDLP_STREAMING` -> use `MUSIC_STREAM_MODE=ytdlp`
- `YTDLP_DIRECT_WAIT_MS` -> removed, no replacement

## Internal (not user-config)

- `XDG_CONFIG_HOME` is set internally by the app and should not be set in templates.
