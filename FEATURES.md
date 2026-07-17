# PackBot Feature Inventory (Phase 0 Audit)

Audit of the Node.js codebase at commit `e4aa732`, produced as the feature-parity contract
for the Go rewrite. Anything not listed here is not a feature. Items marked **⚠️** at the
bottom need a decision before porting.

## Phase 1 scope decisions (confirmed by Ollie, 2026-07-16)

The Go port targets parity with this inventory **except**:

1. **Dropped — Starboard**: `messageReactionAdd`/`messageReactionRemove` handlers, `Starboard` table usage, `/settings set-starboard-channel` + `set-star-threshold`, and `GET /api/starboard/:guildId`. (PackSite's dashboard "Starboard Highlights" card hides itself when the endpoint is gone — verified graceful.)
2. **Dropped — Quotes**: `/quote` command and the three `/api/quotes/*` endpoints. (PackSite profile "Saved Quotes" section also degrades gracefully.)
3. **Dropped — Voice commands (Deepgram)**: `VoiceCommandListener`, the whole `/voice` command family, the join/play auto-enable logic, `VoiceWhitelist` table usage, `Guilds.voiceCommandsEnabled`, and `DEEPGRAM_API_KEY`. Unused/not worth porting. Consequence: with starboard + quotes also gone, the **MessageContent intent question (⚠️-1) is moot** — no remaining feature reads message content.
3a. **Dropped — `/ai`** (OpenAI ask/imagine) and `OPENAI_API_KEY`: not needed (Ollie, 2026-07-16).
3b. **Dropped — cookie-monitor job**: it watches yt-dlp's cookies.txt, which the Lavalink decision (item 8) removes from the Go bot entirely. YouTube auth for playback becomes Lavalink youtube-source plugin configuration.
3c. **Dropped — `/troll`** (Music Taste Correction System) and its in-memory state: "it's not good" (Ollie, 2026-07-16).
3d. **SoundCloud** stays supported via Lavalink's built-in source (`soundcloud: true` in lavalink/application.yml) — URL passthrough, no bot-side code.
4. **Poll votes become stateful**: Go handles `poll_vote_*` component interactions directly against the `Polls` table (no in-memory collector), so votes survive restarts.
5. **Hardcoded IDs → env vars**: web-API super-admin user, owner guild, cookie-alert channel/role.
6. **Bugs fixed in the port, not replicated**: cookie-monitor role-mention ID (⚠️-6), leaderboard-user API username (⚠️-7), silent `/skip`-after-`/join` (⚠️-8 — event wiring moves to subscription creation).
7. Unused DB tables (`Starboard`, `Quotes`, `VoiceWhitelist`, `PageMonitors`, `UserPreferences`-if-unused) are left in MySQL untouched — no destructive migrations during cutover.

8. **Voice stack: Lavalink v4 sidecar.** Discord has enforced the DAVE E2EE protocol for all non-stage voice since 2026-03-01 (close code 4017 without it); discordgo has no merged DAVE support. Decision: the Go bot (discordgo) stays CGO-free and never opens a voice connection itself — a Lavalink v4 container on grid handles voice/DAVE/streaming, replacing the yt-dlp/FFmpeg/direct-URL pipeline (§5 playback internals). Spotify→YouTube resolution and scoring (§5 QueryResolver/utils-youtube logic), queue semantics, autoplay, repeat, history, and ListeningHistory logging stay in Go. Filters map to Lavalink's built-in filter set (timescale/tremolo/vibrato/rotation/equalizer/karaoke…); exotic FFmpeg-only filters (reverse, haas, mcompand, surround, flanger, gate, phaser, normalizer) are dropped from the `/filters` choices.

---

## 1. Runtime overview

- **Entry point:** `index.js`. Loads `.env`, cleans stray yt-dlp temp files (`--Frag*`, `*.part`, `*.ytdl`) from the app dir, resolves the yt-dlp binary path (`YTDLP_PATH`, Windows WinGet fallback for dev), sets `XDG_CONFIG_HOME` to the app dir so the repo's `yt-dlp.conf` is picked up, warns about deprecated env vars, then logs in.
- **Discord library:** discord.js v14 (`@discordjs/voice` 0.19 + `@snazzah/davey` for DAVE voice encryption).
- **Gateway intents:** `Guilds`, `GuildMessages`, `GuildPresences` (privileged), `GuildMembers` (privileged), `GuildVoiceStates`, `GuildMessageReactions`. Partials: `Message`, `Reaction`. **Note: `MessageContent` is NOT requested** (see ⚠️-1).
- **Global state on client:** `client.commands` (Collection), `client.subscriptions` (Map guildId → music Subscription), `client.emotes` + `client.logo` (from `config.json`), `client.api` (WebAPI instance).
- **Presence:** activity `thepck.com`, status online (set on ready).
- **Error handling:** global `unhandledRejection` / `uncaughtException` handlers (registered twice — once in `index.js` log-only, once in `ready.js` where uncaughtException triggers shutdown). SIGINT/SIGTERM → destroy Discord client → `process.exit(0)`.
- **Web API:** started after `clientReady` unless `ENABLE_API=false`, on `API_PORT` (default 3000 in code, 3001 in Docker/env).
- **Command registration:** separate script `node deploy-commands.js` — registers global commands, and guild-scoped commands for any command exporting `guildOnly: '<guildId>'` (currently only `/troll`). Run manually; not part of bot startup or CI.

### interactionCreate dispatch (`events/client/interactionCreate.js`)
- Routes autocomplete → `command.autocomplete(interaction)`; modal submits → any command exposing `handleModalSubmit` (none currently do).
- For slash commands: **defers the reply immediately** (ephemeral when command exports `isEphemeral: true` — currently `/purge` and `/settings`), loads the guild profile through a 5-minute TTL cache (`utils/guildSettingsCache.js`, backed by `database/guilds.js` which upserts the Guilds row on first access), logs the invocation, then calls `command.execute(interaction, guildProfile)`. All commands therefore respond via `editReply`.
- On error: edits reply / sends ephemeral "There was an error while executing this command."

---

## 2. Slash commands (32)

Shared embed conventions: footer `The Pack` + logo icon; colors `#ff006a` (brand), `#ff0000` (error), `#00ff00` (success), `#ffaa00` (warn/info), `#FFD700` (starboard), `#9B59B6` (voice feedback).

### Music playback
| Command | Args | Permissions | Behaviour |
|---|---|---|---|
| `/play [song]` | optional string: URL, playlist URL, or search terms | everyone; user must be in a voice channel | No arg → resumes if paused, else warns. Otherwise joins voice (with join-block checks: bot timeout, ViewChannel/Connect/Speak perms, channel user limit; ready-wait with up to 3 rejoin retries, 20s each), creates a `Subscription`, wires up embed event handlers (playSong/addSong/skip/stop/finish → embeds in the invoking text channel), applies the troll "Music Taste Correction" replacement if enabled for the user, resolves the query via QueryResolver, enqueues track(s). Spotify playlists stream in batches of 100 while playback starts immediately. Sends "Song added"/"Playlist added" embed. Logs every played track to `ListeningHistory`. Auto-enables voice commands if guild opted in + whitelisted. |
| `/join` | – | everyone; user in VC | Joins the caller's channel (same block checks, 10s ready-wait ×3), creates Subscription, self-deafened by default; auto-enables voice commands if opted-in + whitelisted (then undeafens). |
| `/leave` | – | everyone | Clears queue/current/prefetches without emitting events, destroys connection, removes subscription. |
| `/pause` | – | everyone | Toggles pause/resume of the audio player. |
| `/stop` | – | everyone | `subscription.stop(user)` — clears queue+history, stops player, emits `stop` (embed via play.js handler), deletes its own deferred reply. |
| `/skip` | – | everyone | `subscription.skip(user)` — stops current track, emits `skip` embed, deletes its own reply. |
| `/previous` | – | everyone | Plays last track from history (max 50 kept); current track goes back to front of queue. Deletes own reply; `playSong` embed announces. |
| `/seek time` | int seconds, 0..duration | everyone | Restarts stream at offset via FFmpeg `-ss` against the cached/re-resolved direct URL (throws if none obtainable). |
| `/jump position` | int; 1-based, negatives from end | everyone | Jumps to queue position (resolves metadata if lazy), current → history. Deletes own reply. |
| `/volume volume` | int 0–200 | everyone | Sets inline volume on current resource and future tracks. (Volume ≠100 disables the Opus-passthrough fast path.) |
| `/repeat mode` | choice: queue / song / off | everyone | Sets `repeatMode` 2/1/0. |
| `/shuffle` | – | everyone | Fisher-Yates shuffle; clears prefetch caches; prefetches new head. |
| `/queue [page]` | optional int ≥1 | everyone | Paginated embed (10/page): now playing + up next, total duration, loop mode. First/prev/next/last buttons, usable only by the invoker, 2-minute collector. |
| `/nowplaying` | – | everyone | Progress bar, elapsed/total, volume, loop, requester, thumbnail, play-count history from ListeningHistory ("first played by"), next track, status line (autoplay/filters/voice). |
| `/swap position_1 position_2` | two ints | everyone | Swaps queue entries; re-prefetches if head changed. |
| `/push position` | int | everyone | Moves entry to front of queue; prefetches it. |
| `/undo` | – | everyone | Removes the last queued track. |
| `/autoplay` | – | everyone | Toggles autoplay: when queue empties, searches "`artist` `title` related" and queues the first result. |
| `/filters add\|remove\|clear\|list` | choice from 21 filters (bassboost, nightcore, vaporwave, 8d, tremolo, vibrato, reverse, treble, normalizer, surrounding, earrape, karaoke, flanger, gate, haas, mcompand, phaser, pitch_up, pitch_down, slow, fast) | everyone | Maintains an FFmpeg `-af` filter chain and hot-restarts playback at the current position (fast path: cached direct URL + input seek; slow path: yt-dlp pipe re-spawn). |
| `/playlist save\|play\|list\|remove` | save: name (≤50, `[a-z0-9_-]+`) + url; play/remove: name (autocompleted) | everyone | Per-user saved playlists (max 25/user/guild) in `SavedPlaylists`; platform auto-detected (spotify/youtube/soundcloud/other). `play` re-invokes the `/play` command with the stored URL by monkey-patching `interaction.options.getString`. |
| `/voice enable\|disable\|status\|autoenable\|whitelist …` | autoenable: bool; whitelist add/remove/list: guild_id, name | status: everyone; enable/disable: whitelisted guilds only; autoenable: Admin; whitelist: Admin **in owner guild `773732791585865769` only** | Deepgram-powered voice control (see §5). Whitelist stored in `VoiceWhitelist`. `autoenable` persists `Guilds.voiceCommandsEnabled`. |

### Community / fun
| Command | Args | Permissions | Behaviour |
|---|---|---|---|
| `/ai ask\|imagine` | prompt (≤500 / ≤1000) | everyone | OpenAI: `gpt-4o-mini` chat (max 500 tokens, temp 0.8, PackBot persona system prompt) / `dall-e-3` 1024×1024 image. Graceful "not configured" embed without `OPENAI_API_KEY`. |
| `/poll question option1 option2 [option3] [option4] [duration]` | duration 1–1440 min (default 5) | everyone | Button-vote poll, one vote per user (revotable), live-updating bar-chart embed. Persisted to `Polls`; in-process collector closes it, plus a 30-second DB sweep (`scripts/poll-expiry.js`) closes expired polls after restarts (edits message to final results). Votes cast after a bot restart are lost (no persistent button handler — see ⚠️-4). |
| `/quote save\|random\|search\|user\|list` | save: message_id (must be in current channel); search: keyword | everyone | Quote board in `Quotes`. Search tries FULLTEXT `MATCH…AGAINST` then falls back to `LIKE`. List = 5/page with prev/next buttons (invoker-only, 2 min). |
| `/birthday add\|remove\|list` | add: user + `MM-DD` | **Admin** (default member permissions) | CRUD on `Birthdays` (upsert on user+guild). Announcements are a scheduled job (§4). |
| `/wrapped me\|server\|compare` | compare: user | everyone | Spotify-Wrapped-style stats from `ListeningHistory`: totals, top tracks/artists, peak hour; compare = shared-artist compatibility % with emoji tiers. |
| `/leaderboard total\|game\|user\|games\|music` | game: name (autocomplete from DB) | everyone | Playtime leaderboards from `Playtime` (game tracking) and `ListeningHistory` (music). Top-10 embeds with medals. |
| `/troll toggle\|status\|set\|remove` | set: user + YouTube URL | **Admin**; **registered only in guild `773732791585865769`** | "Music Taste Correction System™": while enabled, `/play` queries from targeted users are replaced with a fixed URL (or random rickroll-style alternative). State is **in-memory only** (`music/trollState.js`, resets on restart; ships with one hardcoded target user + `enabled: true`). |

### Admin / server management
| Command | Args | Permissions | Behaviour |
|---|---|---|---|
| `/settings info\|set-live-role\|set-live-channel\|set-general-channel\|set-youtube-channel\|toggle-247\|set-starboard-channel\|set-star-threshold` | role/channel options; threshold 1–25 | **Admin**, ephemeral | Table-driven SETTERS pattern writing columns on `Guilds`; invalidates the guild-profile cache. `info` displays all current values. `toggle-247` flips voice 24/7 mode. |
| `/youtube add\|remove\|view` | handle (@ stripped) | **Admin** | Manages `Youtube` watch-list rows. `add` requires the guild's YouTube channel to be set and validates the handle via YouTube Data API (embed with subs/video count). `view` re-fetches live channel info per row. |
| `/purge amount` | int 1–100 | **Admin** (checked in-code), ephemeral | `bulkDelete(amount, true)` (silently skips >14-day-old messages). |
| `/ping` | – | everyone | "🏓 Pong!" embed. |

---

## 3. Event handlers (`events/client/`)

| Event | Behaviour |
|---|---|
| `clientReady` (once) | Set presence; initialize the four background jobs (§4); register shutdown handlers. |
| `interactionCreate` | Dispatch (see §1). |
| `voiceStateUpdate` | (a) If the **bot** was force-disconnected: full cleanup, no rejoin. (b) If the last non-bot user leaves the bot's channel: leave with a goodbye embed — **unless** `Guilds.twentyFourSevenMode` is set. |
| `messageReactionAdd` | **Starboard**: on ⭐ reaction (non-bot, not in the starboard channel itself), when count ≥ `starThreshold` (default 3), posts/updates a gold embed in `starboardChannelID` (author, content, jump link, channel, first image attachment) and upserts `Starboard` row. Fetches partials. |
| `messageReactionRemove` | Updates star count; deletes the starboard message + DB row if count falls below threshold. |

## 3b. Event functions (`events/event-functions/`, self-registering listener modules)

| Module | Listens to | Behaviour |
|---|---|---|
| `game-expose.js` | `presenceUpdate` | Tracks activity sessions in-memory (keyed user\|activity, wall-clock from when the bot first sees it). On stop: records ≥60s sessions into `Playtime` (upsert, accumulating `totalSeconds`); if the session was ≥6h, announces "X played GAME for N hours!" in `generalChannelID`. Guild channel IDs cached in-memory indefinitely. |
| `live-noti.js` | `presenceUpdate`, `voiceStateUpdate` | Discord streaming (activity type 1) detection. On start: adds `liveRoleID`, announces stream URL embed in `liveChannelID`, and sets "LIVE STREAMING 🔴" as the voice-channel topic/name if streamer is in VC. On stop: removes role, clears channel status. Tracks streaming state and voice channel in-memory; guild profiles cached in-memory indefinitely (no TTL — settings changes need a restart to take effect here). |

---

## 4. Scheduled tasks & background jobs (`scripts/`, started from ready.js)

| Job | Schedule | Behaviour |
|---|---|---|
| `youtube-notifications.js` | node-cron `*/30 * * * *` | For each `Youtube` row joined to guilds with `youtubeChannelID` set: fetch the latest video via YouTube Data API `search` (maxResults=1, optional `PROXY_URL` via https-proxy-agent with 407-failure bypass), concurrency 5 (p-limit). Per-channel exponential backoff on "no new video" cycles (2^misses skipped cycles, capped at `YT_MAX_BACKOFF_MULTIPLIER`, default 8 → 4h). First sighting seeds `lastCheckedVideo` without notifying. New video → embed + link in the guild's YouTube channel, dedupe across guilds sharing a notify channel. Batch-upserts state. Aggregated 403 logging. |
| `birthday-reminders.js` | node-cron `0 9 * * *`, timezone **Australia/Melbourne** | Finds today's `Birthdays` (joined to guilds with `generalChannelID`), groups by channel, mentions everyone with a **deliberately insulting** random message from `birthday-messages.json` (15 entries), plus up to 3 famous birthdays fetched from `today.zenquotes.io`. |
| `cookie-monitor.js` | node-cron `0 9 * * *` + once 10s after startup | Parses the yt-dlp cookies file (`YTDLP_COOKIES_PATH`, default `/usr/src/app/cookies.txt`) for YouTube/Google auth cookies (`__Secure-1PSID` etc.); warns at <30 days, critical at <7 days/expired. Alerts to **hardcoded channel `255258298230636545`** with refresh instructions; pings a role with the **same hardcoded ID** when critical (see ⚠️-6). |
| `poll-expiry.js` | `setInterval` 30s | Closes `Polls` rows past `expiresAt`, edits the poll message to final results and removes buttons. |

Also: `api/WebAPI.setupSubscriptionHooks` polls every 5s to attach WebSocket-forwarding listeners to any new music subscription.

---

## 5. Music subsystem (`music/`)

The most intricate part of the codebase. Key components:

### QueryResolver (`music/QueryResolver.js`, singleton)
- **Input routing:** Spotify URL → Spotify Web API (client-credentials token, auto-refresh); other `http(s)` URL → YouTube API fast path (single video) or yt-dlp (`--dump-single-json`, `--flat-playlist` for playlists); plain text → search.
- **Search:** YouTube Data API when key present (`YT_SEARCH_PROVIDER` auto/api/ytdlp) — fetches 10 candidates, batch video-details (duration + view count), and **scores** them (`utils/youtube.js`): "- Topic" channel +20, "official" +10, penalties for clean/music-video/slowed/nightcore-type edits, log-scale view count up to +20, query-term coverage ±(15/-25), duration match up to +100, −200 if video <60% of expected duration. Fallback: `yt-dlp ytsearch:`.
- **Spotify:** track → search "name artist" with expected duration; album → lazy Track list (searchQuery set, URL resolved later); playlist → returns `{isStreamingPlaylist…}` sentinel that `/play` consumes via async-generator `streamSpotifyPlaylist` (pages of 100).
- **Direct stream URL resolution:** `yt-dlp -g` with format preference `bestaudio[acodec=opus][ext=webm]/…/bestaudio`. `YTDLP_DIRECT_FAST` (default on) skips JSON; fallback fetches JSON + `http_headers`. Timeouts: `YTDLP_DIRECT_TIMEOUT_MS` 15s, `YTDLP_INFO_TIMEOUT_MS` 30s.
- All yt-dlp invocations append `--js-runtimes` (`YTDLP_JS_RUNTIME`, default node), `--remote-components` (default `ejs:github`), optional `--force-ipv4` / `--extractor-args`, and `--cookies` (from `YTDLP_COOKIES_PATH` or parsed out of the yt-dlp config file).

### Track (`music/Track.js`)
Plain data: title, url, spotifyUrl, thumbnail, duration, artist, requestedBy, searchQuery (lazy resolution), needsMetadata, directUrl, directHeaders + `formattedDuration`/`displayUrl` getters.

### Subscription (`music/Subscription.js`, EventEmitter per guild)
- Owns the voice connection, an `AudioPlayer`, `queue[]`, `history[]` (≤50), `repeatMode`, `volume`, `filters[]`, `autoplay`, prefetch caches, and spawned child processes.
- **Events emitted:** `playSong`, `addSong`, `skip`, `stop`, `finish`, `queueUpdate` (debounced 100ms/2s max) — consumed by play.js (embeds) and WebAPI (WebSocket).
- **Connection resilience:** auto-reconnect on disconnect (4014 wait, else up to 5 rejoins with backoff); Destroyed → full teardown. DAVE dependency check logs a warning if `@snazzah/davey` missing.
- **Playback pipeline** (two paths, chosen by `MUSIC_STREAM_MODE` auto/direct/ytdlp):
  1. **Direct URL:** FFmpeg reads the googlevideo/CDN URL directly (`-reconnect*` flags, injected Referer/Origin/User-Agent headers for YouTube — critical to avoid throttling), decodes to s16le/48k stereo, inline volume. Used when a direct URL is cached and mode permits; **auto mode prefers yt-dlp for YouTube URLs** (more resilient).
  2. **yt-dlp pipe:** `yt-dlp -o - -f bestaudio…` piped either straight into discord.js (with **Opus passthrough**: sniffs WebM/Ogg magic bytes and streams Opus without re-encode when volume=100 and `MUSIC_OPUS_PASSTHROUGH` on) or through FFmpeg when filters/seek are active.
- **Prefetching:** next track's direct URL or a whole prefetched yt-dlp process+stream (1 MiB buffer, `YTDLP_PREFETCH_BYTES`); Spotify lazy tracks pre-resolved via search. Background direct-URL resolution also runs for the current track so `/seek` and `/filters` restart fast.
- **Early-termination retry:** if a track goes Idle after playing <70% of its expected duration (and >5s), it is re-queued once with `_forceYtdlpStream` and a 3s-overlap seek offset.
- **Autoplay, repeat (song/queue), seek, jump, previous** implemented here; killing of stale FFmpeg/yt-dlp processes on every transition.

### VoiceCommandListener (`music/VoiceCommandListener.js`)
- Deepgram `nova-2` live transcription (16kHz mono PCM via prism-media Opus decode), keep-alive every 10s.
- Wake phrase "pack bot" with ~50 hardcoded mishearing variants + fuzzy regex; false-positive filter; pending-wake state (wake phrase in one utterance, command in the next, 4s TTL).
- Commands: play (with a speech-correction dictionary for artist names), skip/next, stop, pause, resume, volume (word-numbers like "one fifty" parsed), previous, shuffle, queue. Unmatched text ≥3 chars is treated as a play query. 2s per-user cooldown. Purple embeds as feedback.
- Speaker attribution: receiver `speaking` events, falls back to "only human in channel".
- Enabled per-subscription; bot undeafens itself while listening, re-deafens on disable.
- **⚠️-3: `runCommand`'s play case references `logTimings`/`timingStart` which are only defined in `executeCommand` — a `ReferenceError` that makes voice-play fail (caught and shown as an error embed).**

---

## 6. Web API (`api/WebAPI.js`) — Express + Socket.io on `API_PORT`

- **Middleware:** `trust proxy` 1, CORS from `CORS_ORIGIN` (credentials on), JSON body, express-session with in-process TTL store (`utils/ttl-session-store.js`, 7-day cookies, `secure:'auto'` in production).
- **Auth:** Discord OAuth2 (`identify guilds` scopes) → session stores user + access/refresh tokens + mutual guilds with per-guild `isAdmin` (permission bit 0x8). Hardcoded super-admin user **`101784904152395776`** sees/administers all guilds.
- **Guild access rule:** every guild-scoped endpoint checks session user's mutual guilds (or super-admin).

Endpoints (all under `/api`):

| Area | Endpoints |
|---|---|
| Public | `GET /stats` (guild/user counts, uptime, ping, active voice), `GET /status` |
| Auth | `GET /auth/discord` (redirect), `GET /auth/callback`, `GET /auth/me`, `POST /auth/logout` |
| Guilds | `GET /guilds` (accessible guilds + isAdmin flags) |
| Now playing | `GET /nowplaying/:guildId`, `GET /queue/:guildId` (paginated) |
| Queue management | `POST /queue/:guildId/add` (search+enqueue; requires an active session), `DELETE /queue/:guildId/:position`, `POST /queue/:guildId/move`, `POST /queue/:guildId/shuffle`, `POST /queue/:guildId/clear` — all audit-logged |
| Player | `POST /player/:guildId/pause` (toggle), `/skip`, `/previous`, `/seek`, `/stop`, `GET /player/:guildId/status` |
| Leaderboards | `GET /leaderboard/:guildId` (?game=), `GET /leaderboard/:guildId/user/:odUserId` |
| History | `GET /history/:guildId` (paginated, ?userId=), `GET /history/:guildId/stats` |
| Profiles | `GET /profile/:userId` (stats/top tracks/artists/recent/badges), `GET /profile/:userId/compatibility/:otherUserId` |
| Wrapped | `GET /wrapped/:guildId/server`, `GET /wrapped/:guildId/compare/:u1/:u2`, `GET /wrapped/:guildId/:userId` |
| Quotes | `GET /quotes/:guildId`, `/random`, `/user/:userId` |
| Starboard | `GET /starboard/:guildId` |
| Playlists | `GET/POST /user/playlists`, `DELETE /user/playlists/:id` |
| YouTube | `GET/POST /youtube/:guildId`, `DELETE /youtube/:guildId/:handle` (POST/DELETE require guild admin) |
| Settings | `GET /settings/:guildId` (incl. available channels/roles for dropdowns), `PUT /settings/:guildId` (guild admin; whitelisted-only for voiceCommandsEnabled) |

**WebSocket (Socket.io):** clients `subscribe`/`unsubscribe` to `guild:<id>` rooms; server pushes `nowplaying` and `queueUpdate` payloads on subscription events (skip triggers immediate + 500ms + 1500ms refreshes).

**Frontend:** `PackSite/` is a **separate nested git repo** (Vite + vanilla JS + three.js logo) consuming this API; deployed independently by `scripts/deploy-packsite.ps1` (local Vite build → rsync over WSL to nginx html dir on grid). It is git-ignored by the PackBot repo and not part of the bot rewrite.

---

## 7. Persistence (MySQL, `mysql2/promise` pool, 10 conns)

Config from `MYSQL_HOST/PORT/USER/PASSWORD/DB`. Migrations = numbered `.sql` files run by `node database/migrate.js` (splits on `;`, tolerates already-exists errors; **no migrations tracking table** — idempotence relies on error codes). `schema.sql` is a from-scratch snapshot but is **missing the tables added in migrations 014–017** (Birthdays, Polls, Quotes, Starboard + starboard columns on Guilds).

| Table | Purpose / notable columns |
|---|---|
| `Guilds` | Per-guild settings: liveRoleID, liveChannelID, generalChannelID, youtubeChannelID, voiceCommandsEnabled, twentyFourSevenMode, starboardChannelID, starThreshold. Auto-upserted on first interaction. |
| `Youtube` | Watch-list: handle, channelId, guildId (unique pair), lastCheckedVideo, initialized, lastChecked. |
| `Playtime` | guildId+odUserId+gameName unique; accumulating totalSeconds; lastPlayed. |
| `VoiceWhitelist` | Guilds allowed to use Deepgram voice commands. |
| `SavedPlaylists` | guildId+userId+name unique; url; platform. |
| `UserPreferences` | odUserId unique; favoriteGuildId (web dashboard only). |
| `ListeningHistory` | Every played track: guild, user, title/artist/url/thumbnail, durationSeconds, playedAt. Heavily indexed (migration 018). |
| `Birthdays` | userId+guildId unique; name; birthMonth/birthDay. |
| `Polls` | question, options JSON, votes JSON (optionIndex→userId[]), expiresAt, closed. |
| `Quotes` | messageContent (FULLTEXT indexed), authorId, savedBy, channel/message ids. |
| `Starboard` | guildId+originalMessageId unique; starboardMessageId, starCount, content snapshot. |
| `PageMonitors` | **Dead** — no code references it (see §10). |

Other state:
- **In-memory only (lost on restart):** music queues/history, troll state, poll button collectors, playtime session start-times, live-streaming state, guild-profile caches, backoff state for YouTube polling, OAuth sessions.
- **Files:** `logs/packbot.log` (custom logger: level filter, 10s dedup window, size-based rotation, text/JSON console formats), `cookies.txt` (git-ignored, mounted in Docker), `yt-dlp.conf`.

---

## 8. External integrations

| Service | Used by | Auth |
|---|---|---|
| Discord Gateway/REST + Voice (DAVE encryption) | everything | `TOKEN`, `CLIENT_ID` |
| Discord OAuth2 | Web API login | `DISCORD_CLIENT_SECRET`, `OAUTH_REDIRECT_URI`, `FRONTEND_URL` |
| MySQL/MariaDB (on grid) | persistence | `MYSQL_*` |
| YouTube Data API v3 | search+scoring, video details, channel lookup, upload polling | `YOUTUBE_API_KEY` (optional; yt-dlp fallback for search) |
| yt-dlp (subprocess) | metadata, direct URLs, audio streaming | binary at `YTDLP_PATH`; cookies file |
| FFmpeg (subprocess) | decode/filter/seek | system ffmpeg or ffmpeg-static |
| Spotify Web API | track/album/playlist resolution | `SPOTIFY_CLIENT_ID/SECRET` (optional) |
| Deepgram (nova-2 live) | voice commands | `DEEPGRAM_API_KEY` (optional, whitelist-gated) |
| OpenAI (gpt-4o-mini, dall-e-3) | `/ai` | `OPENAI_API_KEY` (optional) |
| zenquotes.io (`today.zenquotes.io/api/M/D`) | famous birthdays flavor | none |
| HTTP proxy | YouTube polling only | `PROXY_URL` (optional) |

Full env-var contract: see `ENVIRONMENT.md` (canonical) — required: `TOKEN`, `CLIENT_ID`, `MYSQL_*`; plus API/logging/music-tuning optionals and a deprecated list that startup warns about. The Unraid template (`unraid/my-PackBot.xml`) mirrors all of these.

---

## 9. Build & deploy pipeline

- **CI (`.github/workflows/docker-image.yml`):** on push to master/main or `v*` tags (and manual dispatch): QEMU + Buildx → DockerHub login (`DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` secrets) → build `linux/amd64` from `Dockerfile` → push tags `latest` (default branch), tag refs, and `sha-<short>`. GHA layer cache. **No test/lint step.**
- **Dockerfile:** single-stage `node:22.13.1` (Debian). Installs ffmpeg, python3/pip → `pip install yt-dlp`, plus a set of GUI/browser libs (libnss3, libgtk-3, libgbm…) that are **leftovers from the removed Puppeteer page-monitor feature** — dead weight for the Go image. `npm install`, copy source, env defaults (YTDLP_PATH, LOG_*, API_PORT=3001), `EXPOSE 3001`, `CMD node index.js`. No HEALTHCHECK, runs as root, no graceful-shutdown tini (Node handles SIGTERM itself).
- **Deploy to grid:** the container is defined by the Unraid template `unraid/my-PackBot.xml` (host network, mounts for `/app/logs`, `/root/.config/yt-dlp`, `/usr/src/app/cookies.txt`, all env vars). Update = pull `olliepck/packbot:latest` + restart, via `scripts/deploy-packbot.ps1` (SSH from Windows) or `scripts/unraid/packbot-restart.sh` on the box. So: **push to master → image on DockerHub → manual/scripted pull+restart on Unraid.**
- **Slash-command registration** (`node deploy-commands.js`) is a separate manual step whenever command definitions change.
- **PackSite** deploys separately via `scripts/deploy-packsite.ps1` (rsync static build to nginx) — untouched by the Go rewrite.
- `scripts/music_selftest.py`: two regex-based regression guards against `music/Subscription.js` (recursion + Range-header injection). Not wired into CI; obsolete once the code is Go.

---

## 10. Dead code & removed features (candidates to drop, not port)

1. **`utils/httpClient.js` + `utils/queueitDetector.js`** — only reference each other; no live imports. Remnants of the removed page-monitor feature. *(Confirmed also unused by the PackSite sub-repo — it's a browser frontend that only talks to `/api/*`; the only grep hits there were `.queue-item` CSS classes.)*
2. **`PageMonitors` table** (+ migrations 005/011/012) — no code reads or writes it.
3. **Migration 013** drops old `Imax*` tables — evidence of another removed feature; nothing to port.
4. **Dockerfile browser libraries** (libnss3, libgtk-3, etc.) — Puppeteer leftovers.
5. **`QueryResolver.getDirectStreamUrl`** — thin wrapper nothing calls (callers use `getDirectStreamInfo`/`getDirectStreamUrlFast`).
6. **README's `services/` directory** — doesn't exist.
7. `schema.sql` lags the migrations (see §7) — for Go I'd treat migrations as the source of truth.

## 11. ⚠️ Ambiguities / suspected bugs — please confirm before Phase 1

1. **MessageContent intent is not requested**, but starboard embeds and `/quote save` read `message.content`. Discord redacts content without that intent (unless the bot is mentioned/author). Does quote/starboard actually show message text in production? If yes, something non-obvious is going on; if no, this is a live bug. Either way the Go port must decide whether to request the privileged intent.
2. **Hardcoded IDs** scattered in code rather than config: Web API super-admin `101784904152395776`; owner guild `773732791585865769` (voice whitelist management + `/troll` registration); cookie-monitor alert channel `255258298230636545` (see 6). Port as-is, or promote to env vars? (Env vars recommended; behaviour identical.)
3. **Voice-command "play" is broken:** `VoiceCommandListener.runCommand` references `logTimings` and `timingStart` that only exist in `executeCommand`'s scope → `ReferenceError`, surfaced as "❌ Error: logTimings is not defined". Faithful parity would port the bug; I assume you want it fixed — confirm.
4. **Poll votes after a restart are dropped** (button collector is in-memory; there's no global `poll_vote_*` interaction handler). Poll-expiry only finalizes the embed. Port this limitation, or handle votes statefully in Go (the DB already stores everything needed)?
5. **`/troll` state resets on restart** and ships enabled with a hardcoded victim. Intentional? Port identically?
6. **Cookie-monitor critical ping** uses the *channel* ID as a *role* mention (`<@&255258298230636545>`) — the code comment itself says "adjust role ID if needed". Almost certainly pings nothing. Fix or keep?
7. **Web API `GET /leaderboard/:guildId/user/:odUserId`** returns `username: rows[0]?.odUsername`, but the SELECT doesn't include `odUsername` → always "Unknown". Minor; fix in port?
8. **`/skip`, `/stop`, `/jump`, `/previous` produce no visible response if music was started without `/play`** (their embeds come from event handlers that only `/play` wires up; e.g. `/join` then `/skip` deletes its reply and nothing announces). Edge case — port as-is or wire events on `/join` too?
9. **Two competing uncaughtException handlers** (index.js log-only vs ready.js exit-on-crash). In Go there'll be one recovery/shutdown strategy — no behaviour question, just noting the Node behaviour is ambiguous.
10. **Birthday messages are intentionally brutal** — confirming that's the desired tone to carry over verbatim.
11. **`API_PORT` default mismatch** — code default 3000, Docker/env 3001. Unraid uses host networking so the env value wins; Go port will default to 3001 to match deployment.

---

*End of Phase 0 inventory. Awaiting confirmation before scaffolding the Go project.*
