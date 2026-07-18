# PackBot

PackBot is a Discord bot for The Pack: music playback, playtime leaderboards,
YouTube upload notifications, streaming alerts, birthdays, polls, and a web
API/dashboard at [thepck.com](https://thepck.com).

It's written in Go (`cmd/packbot`, `internal/`) on a small, explicit stack:

- **[discordgo](https://github.com/bwmarrin/discordgo)** — gateway and REST.
- **Lavalink v4 sidecar** — owns Discord voice (including DAVE E2EE), audio
  sourcing and filters; the bot talks to it via
  [disgolink](https://github.com/disgoorg/disgolink) (locally forked in
  `third_party/`, see its README). Node config lives in `lavalink/`.
- **stdlib `net/http`** web API with Discord OAuth login and a plain-WebSocket
  realtime feed (`/api/ws`); the frontend (PackSite) is a separate repo nested
  at `PackSite/`.
- **MySQL/MariaDB** via `database/sql`; schema in `database/`.

The bot was originally Node.js (discord.js v14 + yt-dlp/FFmpeg); the Go
rewrite reached feature parity and replaced it in production in July 2026.
[FEATURES.md](FEATURES.md) is the parity contract with all port decisions,
[ENVIRONMENT.md](ENVIRONMENT.md) the env-var reference, and
[CUTOVER.md](CUTOVER.md) the executed switch-over runbook. The Node source
was removed after the cutover — it's all in git history before that point.

## Features

### 🎵 Music
`/play` (YouTube, YouTube Music, Spotify links/albums/playlists, SoundCloud,
plain-text search with Spotify-informed matching), full queue control
(`/queue`, `/skip`, `/previous`, `/shuffle`, `/repeat`, `/jump`, `/swap`,
`/push`, `/undo`, `/seek`, `/volume`, `/pause`), `/autoplay` (YouTube Mix
based related tracks), `/nowplaying`, and `/filters` — live Lavalink filters
including bassboost, nightcore, vaporwave, 8D, slowed + reverb, and earrape.

### 📊 Tracking & community
- `/leaderboard` — playtime leaderboards (total, per-game, per-user).
- `/wrapped` — yearly listening recap; `/playlist` — saved playlists.
- `/youtube` — YouTube upload notifications for subscribed channels.
- `/birthday` — birthday reminders (09:00 Melbourne time).
- `/poll` — polls with stateful votes that survive restarts.
- Game-expose (6h+ session callouts) and Discord streaming alerts.
- `/settings` — per-guild channels/roles/toggles; `/purge`, `/ping`.
- `/ytauth` — owner-only (DM) YouTube OAuth token rotation for Lavalink.

### 🌐 Web API
REST under `/api` (stats, OAuth login, guild settings, leaderboards,
listening history, playlists, wrapped, music control) plus WebSocket
now-playing/queue updates. Serves the PackSite dashboard.

## Running it

### Prerequisites
- A Lavalink v4 node with the `youtube-source` and `lavalink-filter-plugin`
  plugins — `lavalink/application.yml` is the reference config (YouTube
  OAuth setup steps are commented inline).
- MySQL/MariaDB with the schema applied.
- A Discord application (bot token + OAuth client secret).

### Local development
```sh
cp .env.example .env   # fill it in (Go doesn't auto-load .env; export the
                       # vars or run via your IDE/wrapper of choice)
go test ./...
go run ./cmd/packbot
```

Set `REGISTER_COMMANDS=true` with a `DEV_GUILD_ID` on first run against a
dev Discord application (guild-scoped registration propagates instantly).

### Database setup
Point the bot at an empty database — it applies the numbered migrations in
`database/migrations/` automatically at startup (they're embedded in the
binary and tracked in a `SchemaMigrations` table). `database/schema.sql`
remains as a point-in-time reference of the full schema.

### Docker
```sh
docker build -t olliepck/packbot-go .
docker run --env-file .env olliepck/packbot-go
```

CI (`.github/workflows/go-image.yml`) vets, tests, and publishes
`olliepck/packbot-go:latest` + `:sha-<commit>` to DockerHub on every push to
master. Requires `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` repo secrets.

### Unraid
Templates in `unraid/`: `my-PackBot-Go.xml` (the bot) and
`my-PackBot-Lavalink.xml` (the Lavalink node). Note that pulling a new image
and restarting is NOT enough on Unraid — recreate the container (Docker UI
"apply update", or
`/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/update_container`).

### PackSite deploy
The frontend builds locally and ships via scp:
```powershell
Copy-Item .\scripts\deploy.config.example.json .\scripts\deploy.config.json
# edit host/user/targetPath, then:
./scripts/deploy-packsite.ps1
```

## Project structure
```
PackBot/
├── cmd/packbot/        # Entry point (config, wiring, graceful shutdown)
├── cmd/wstest/         # WebSocket diagnostic client
├── internal/
│   ├── bot/            # Gateway session, command registration & dispatch
│   ├── commands/       # Slash commands
│   ├── music/          # Queues, resolution, filters, Lavalink glue
│   ├── api/            # Web API + WebSocket hub
│   ├── storage/        # MySQL data access
│   ├── jobs/           # Background jobs (birthdays, polls, YouTube)
│   ├── trackers/       # Presence trackers (game-expose, live-noti)
│   ├── spotify/ youtube/ config/ logging/ style/
├── third_party/        # Vendored disgolink fork (RotationHz fix)
├── lavalink/           # Lavalink node reference config
├── database/           # schema.sql + numbered migrations
├── unraid/             # Unraid container templates
└── scripts/            # PackSite deploy script
```

## License
MIT — see [LICENSE](LICENSE).
