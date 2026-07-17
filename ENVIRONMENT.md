# Environment Contract (Go bot)

Canonical environment variables for PackBot (Go rewrite). Names match the
old Node contract wherever the variable survived the port, so the Unraid
deployment carries over with minimal changes.

## Required

- `TOKEN` — Discord bot token
- `CLIENT_ID` — Discord application ID (used for command registration)
- `MYSQL_HOST`
- `MYSQL_PORT`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_DB`

## Command registration

Replaces the Node repo's manual `node deploy-commands.js` step.

- `REGISTER_COMMANDS` — `true` to bulk-overwrite the application's slash
  commands on startup (default `false`). **A global overwrite replaces all
  existing global commands for the application** — only enable against the
  production application at cutover, and only after the bot is in its guilds
  (registering before the app is authorized gets wiped by the OAuth flow).
- `DEV_GUILD_ID` — scope registration to one guild (instant propagation;
  used with the dev application for testing). Empty = global.

## Music (Lavalink)

The Go bot plays audio through a Lavalink v4 node (see
`lavalink/application.yml`); it does not use yt-dlp/FFmpeg. Discord's DAVE
E2EE voice requirement is satisfied by Lavalink.

- `LAVALINK_ADDRESS` — e.g. `192.168.1.16:2333`. Empty disables music.
- `LAVALINK_PASSWORD` — must match `lavalink.server.password` in the node config.
- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` — Spotify link resolution
  and plaintext-search enrichment (optional; Spotify links error without it).
- `YOUTUBE_API_KEY` — scored Spotify→YouTube matching fallback, `/youtube`
  command, upload-notifications job (optional; features degrade gracefully).

## Web API

- `ENABLE_API` — default `true`; `false` disables the whole web API.
- `API_PORT` — default `3001` (matches the deployed containers).
- `CORS_ORIGIN` — default `*`; production uses `https://thepck.com`.
- `DISCORD_CLIENT_SECRET` — OAuth login (required for web login).
- `OAUTH_REDIRECT_URI` — e.g. `https://thepck.com/api/auth/callback`.
- `FRONTEND_URL` — post-login redirect base, e.g. `https://thepck.com`.
- `API_ADMIN_USER_ID` — Discord user ID of the web super-admin (sees all
  guilds). Was hardcoded in the Node bot; promoted to config in the port.
  Doubles as the bot-owner identity: receives operational DMs (YouTube
  OAuth login-wall alerts with re-link steps) and is the only user allowed
  to run the DM-only `/ytauth` command (push a fresh refresh token into
  Lavalink at runtime).
- `NODE_ENV` — `production` enables Secure session cookies behind the
  HTTPS proxy (name kept from the Node deployment for template continuity).
- `SESSION_SECRET` — **no longer used** (sessions are server-side random
  IDs); harmless if still set.

## Jobs / misc

- `PROXY_URL` — optional HTTP proxy for YouTube upload polling only.
- `YT_MAX_BACKOFF_MULTIPLIER` — polling backoff cap (default 8 → 4h).
- `TZ` — container timezone (birthday reminders always use
  Australia/Melbourne regardless).

## Logging

Logs go to stdout only (12-factor; Docker/Unraid capture them). The Node
logger's file rotation is gone.

- `LOG_LEVEL` — `debug|info|warn|error` (default `info`)
- `LOG_FORMAT` — `text|json` (default `text`)

## Removed with the Node bot

Set-and-ignored; startup does not warn. Drop them from templates when
convenient: `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `LOG_COLORS`, `LOG_DIR`,
`LOG_MAX_SIZE_MB`, `LOG_MAX_FILES`, `LOG_MUSIC_TIMINGS`, `LOG_YTDLP_TIMINGS`,
`MUSIC_STREAM_MODE`, `MUSIC_OPUS_PASSTHROUGH`, `YT_SEARCH_PROVIDER`, and all
`YTDLP_*` variables (the Go bot has no yt-dlp).
