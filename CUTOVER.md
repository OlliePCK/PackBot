# Node → Go Cutover Runbook

One-evening cutover from the Node bot (`packbot` container) to the Go bot
(`packbot-go`), keeping the Node container stopped-but-present for rollback.
Everything below runs on grid unless noted.

## Already in place (from the rewrite phase)

- ✅ Lavalink v4 on grid: container `packbot-lavalink`, port 2333, config at
  `/mnt/user/appdata/packbot-lavalink/application.yml` (youtube-source +
  filter plugins), `--restart unless-stopped`.
- ✅ `olliepck/packbot-go:latest` published to DockerHub by
  `.github/workflows/go-image.yml` on every master push.
- ✅ Database: the Go bot uses the same prod `packbot` schema; no migrations
  needed (dropped features' tables are simply unused). `packbot_test` on the
  same MariaDB can be deleted whenever.

## Pre-flight checklist

- [ ] CI green on master (vet + tests + image push).
- [ ] PackSite changes (plain-WebSocket client) built locally: `npm run build`
      in PackSite — do **not** deploy yet.
- [ ] Prod Discord application (`CLIENT_ID` 788541157151866881): no dev-portal
      changes needed — the bot is already in its guilds, OAuth redirect URI
      unchanged, and Presence/Members privileged intents were already on.

## Cutover sequence

1. **Create the `PackBot-Go` container** from `unraid/my-PackBot-Go.xml`:
   prod `TOKEN`/`CLIENT_ID`, `MYSQL_DB=packbot`,
   `LAVALINK_ADDRESS=localhost:2333` + password,
   Spotify/YouTube keys from the old container,
   `API_ADMIN_USER_ID=101784904152395776`, `REGISTER_COMMANDS=false` for now.
   The Node container is still running — two gateway sessions on one token is
   fine briefly, but both will answer events, so keep this window short.

2. **Stop the Node container** (`docker stop packbot`). Do not remove it.

3. **Register commands**: set `REGISTER_COMMANDS=true` on PackBot-Go and
   restart it. Watch the log for `slash commands registered confirmed=28
   scope=global`. This overwrite **replaces** the Node bot's global commands
   (removes /quote, /voice, /troll, /ai; global commands can take up to an
   hour to propagate to all clients). Set `REGISTER_COMMANDS=false` again
   afterwards so later restarts don't re-register.

4. **Smoke test in Discord**: `/ping`, `/play` (Spotify link + plain search),
   `/queue`, `/filters add` bassboost, `/leaderboard total`, `/settings info`.

5. **Deploy PackSite**: `scripts/deploy-packsite.ps1` from the dev machine
   (ships the plain-WebSocket client).

6. **nginx tweaks** (Nginx-Proxy-Manager / nginx config for thepck.com):
   - Point the `/api` upstream at the Go container: `proxy_pass
     http://packbot:3001` → the new container's name (e.g. `PackBot-Go`),
     and make sure PackBot-Go is on the same Docker network nginx uses for
     name resolution (laserproxy).
   - Add `proxy_read_timeout 86400;` to the `/api` proxy location (long-lived
     WebSocket at `/api/ws` dies at the default 60s otherwise).
   - The `/socket.io` location block is dead; remove whenever convenient.
   - Reload nginx.

7. **Web smoke test**: log in at thepck.com, nowplaying page: server list,
   Live indicator, play a song, page controls (pause/skip/add-to-queue).

8. **Housekeeping** (done 2026-07-17): `packbot_test` database deleted; dead
   env vars dropped from the Go template; Node code removed from the repo
   (lives on in git history pre-cleanup); `/socket.io` nginx block removed.

## Rollback

**Retired 2026-07-17.** The one-command rollback (`docker start packbot`)
existed only while the stopped Node container and `olliepck/packbot:latest`
image were kept on grid; both were removed once the Go bot proved stable, so
this runbook is now historical. Recovering the Node bot would mean rebuilding
its image from history before commit `7500d8f` (`git checkout 7500d8f~1 --`
the deleted paths), redeploying it, re-registering its commands
(`node deploy-commands.js`), and reverting the PackSite deploy to a
Socket.io build.

## Known behavioural differences (accepted in FEATURES.md)

- Dropped: starboard, quotes, Deepgram voice commands, /ai, /troll,
  cookie-monitor, page-monitor remnants.
- Sessions (web login) reset on bot restart — same as Node in practice.
- Logs to stdout only (`docker logs packbot-go`), no log files.
- `/api/stats` reports version `2.0.0-go`.
- Music: Lavalink-based — richer filters, no cookies.txt maintenance; the
  yt-dlp cookie machinery is gone entirely.
