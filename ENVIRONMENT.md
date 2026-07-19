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

## AFL predictions

- `AFL_API_URL` — base URL of the AFL prediction model's dashboard (e.g.
  `http://192.168.1.16:3002`); the bot reads its `/api/predictions` route.
  Empty disables `/tips`, the weekly round-preview post (Thursday 19:00
  Sydney, after the model's post-team-announcement refresh), and the
  5-minutes-before-kickoff pings. Guilds opt in with
  `/settings set-afl-channel`; club-logo application emojis self-sync on
  startup.

## Main-guild Jellyfin media

This integration is disabled by default and has no fallback guild. When
enabled, PackBot reads the main guild's `generalChannelID` (set with
`/settings set-general-channel`) and refuses to send anywhere else. Invalid
media settings disable this integration without stopping the rest of PackBot.

- `MEDIA_ENABLED` - `true` enables Live TV cards and optional AFL watch links.
- `MEDIA_GUILD_ID` - the one friends guild allowed to receive media output.
- `JELLYFIN_URL` - internal base URL reachable from the PackBot container,
  for example `http://binhex-jellyfin:8096`.
- `JELLYFIN_PUBLIC_URL` - public HTTPS base URL used for Discord link buttons.
  Recipients must already be signed in to Jellyfin; no token is put in links.
- `JELLYFIN_API_KEY` - dedicated Jellyfin API key. Treat it as a secret and
  mask it in the container template.
- `MEDIA_USER_ALIASES_JSON` - JSON object mapping allowlisted Jellyfin user IDs
  to the friendly names shown in Discord. Unknown users are ignored.
  Example: `{"stable-user-id":"Ollie"}`.
- `MEDIA_CHANNELS_JSON` - JSON object mapping allowlisted Jellyfin channel IDs
  to safe display names. Other channels are ignored. Example:
  `{"stable-channel-id":"Fox Sports 503"}`.
- `MEDIA_AFL_CHANNEL_IDS` - comma-separated, ordered subset of the channel-map
  keys used for AFL guide matching; the first matching channel wins.
- `MEDIA_POLL_INTERVAL` - Jellyfin session poll interval (default `15s`,
  minimum `5s`).
- `MEDIA_ANNOUNCE_DELAY` - required continuous viewing before a new card is
  sent (default `15s`; at least one poll interval).
- `MEDIA_STOP_GRACE` - missing-session grace before the card is removed
  (default `30s`; at least one poll interval).

The bot polls Jellyfin's Sessions and Live TV guide APIs only. It does not
need Dispatcharr or Notifiarr credentials. AFL links appear only in the main
guild: `Join on Jellyfin` when that exact channel already owns the single
upstream slot, `Watch on Jellyfin` when the slot is idle, and no link when a
different or ambiguous channel state is active.

This is a fail-closed advisory check against Jellyfin's current sessions, not
an atomic tuner reservation. Jellyfin must be the only playback path that can
consume the provider connection; direct Dispatcharr/provider playback and a
state change after the reminder cannot be observed or reserved. Leave
`MEDIA_AFL_CHANNEL_IDS` empty if other playback paths can consume the slot.

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
