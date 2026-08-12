# PackCraft — Minecraft server

Operational notes for the Pack's Minecraft server and its PackBot integration.
Current as of 2026-08-12.

---

## 1. Where everything lives

| | |
|---|---|
| Server | Paper **26.2** build 112, on Java 25 |
| Panel | Pterodactyl, server name **PackCraft** |
| Container | `ghcr.io/pterodactyl/yolks:java_25` |
| Server UUID | `f59a0d0b-4eaf-4164-b5ee-112e03039981` |
| Files (host) | `/mnt/user/pterodactyl-node/data/<uuid>/` |
| Files (in container) | `/home/container/` |
| Memory | ~8.4 GB (`-XX:MaxRAMPercentage=95.0`) |
| Host | `grid` (Unraid), LAN `192.168.1.16`, tailnet `100.124.160.7` |
| Backups | `/mnt/user/backups/minecraft/` |

**File ownership inside the server directory must be `100:101`.** Anything
written as root won't be readable by the server process. After any host-side
edit: `chown 100:101 <path>`.

### Published ports

| Port | Bind | Purpose |
|---|---|---|
| 25565 | `0.0.0.0` | Minecraft, reached via the relay |
| 25575 | `192.168.1.16` | RCON — **LAN only, never expose** |
| 8100 | `0.0.0.0` | BlueMap web, reached directly by Cloudflare Tunnel |

---

## 2. Network path

```
player → mc.thepck.com (A → 139.84.204.66, DNS only)
       → Vultr Melbourne VPS "mc-relay"  ($5/mo, ~3ms)
       → nginx stream :25565
       → Tailscale (tag:relay, scoped to tcp/25565 on grid only)
       → grid:25565 → container
```

The home connection has **no inbound port forward for Minecraft**. The relay is
the only public endpoint; the grid is reached over the tailnet.

```
map.thepck.com → Cloudflare Tunnel → 192.168.1.16:8100 (BlueMap directly)
```

**The map does not go through NPM any more.** It used to be
Tunnel → NPM → BlueMap; removing that hop is a simplification rather than a fix
for anything (see the SSE note in §7). The tunnel is dashboard-managed (it runs
with `--token`), so its routes live in Cloudflare Zero Trust → Networks →
Tunnels → Public Hostnames, *not* in a config file on grid.

### Why it's built this way

The previous relay was an AWS EC2 instance that was terminated; its tailnet node
went offline 2026-03-31 and nobody noticed for four months because everything
*else* had migrated to Cloudflare Tunnel. Cloudflare Tunnel cannot carry raw TCP,
so Minecraft always needed a separate path. The Vultr relay is that path, at a
quarter of the AWS cost.

**`grid`'s Tailscale key expiry is disabled.** Leave it that way — with expiry on,
the key lapses and the relay's upstream dies, reproducing the original outage.

---

## 3. Current configuration

```properties
difficulty=hard            hardcore=true
white-list=true            enforce-whitelist=true
online-mode=true           max-players=20
spawn-protection=0         view-distance=10
simulation-distance=10     gamemode=survival
enable-rcon=true           rcon.port=25575
pause-when-empty-seconds=-1
motd=§x§f§f§0§0§6§aPackCraft §8| §7Hardcore\n§8The Pack
```

`hardcore=true` forces difficulty to hard regardless of the `difficulty` line,
and puts dead players into spectator. `/gamemode survival <player>` is the lever
for second chances.

**`pause-when-empty-seconds` must stay `-1`.** At any positive value the server
sleeps once the last player leaves, which stops BlueMap catching up on renders
while nobody is online.

Also set, outside `server.properties`:

- `spigot.yml` → `sample-count: 20` (must be ≥ `max-players`; PackBot's playtime
  tracking reads the ping sample)
- `paper-world-defaults.yml` → `anti-xray.enabled: true`, `engine-mode: 1`
- gamerule `players_sleeping_percentage = 30` — **per-world, so every wipe
  clears it.** Re-apply it after regenerating the world.

---

## 4. Plugins (8)

| Plugin | Purpose |
|---|---|
| EssentialsX 2.22.1-dev+17 | `/home`, `/tpa`, `/warp`, welcome text |
| LuckPerms 5.5.71 | permissions |
| CoreProtect CE 24.0 (master build) | block logging, `/co rollback` |
| AxGraves 1.29.0 | death graves |
| BlueMap 5.23 | web map |
| Chunky 1.5.3 | world pre-generation |
| ViaVersion / ViaBackwards 5.12.0 | cross-version client support |

`spark` ships inside Paper — don't install it separately.

**EssentialsX is a dev build**, not a release. The 2.22.0 release logs
"unsupported server version" on 26.2; the dev line supports it. Get builds from
`https://ci.ender.zone/job/EssentialsX/lastSuccessfulBuild/artifact/jars/`.

**CoreProtect is compiled from upstream master** — see §6 for how, and §7 for
the build flag that will otherwise make it refuse to start.

**BlueMapStructuresPaper was removed** (2026-08-11). It published ~11,200
structure markers and warned in its own logs that anything over 5,000 makes the
web app sluggish. Structure spoilers also matter more in hardcore.

### 16 Vanilla Tweaks datapacks

In `world/datapacks/`. **Per-world — a wipe deletes them**, so keep the zips.
A stashed copy lives in `/mnt/user/appdata/mcstage/datapacks/`.

Armor Statues · More Mob Heads · Custom Nether Portals · Fast Leaf Decay ·
Unlock All Recipes · Painting Picker · Elevators · More Effective Tools ·
Dragon Drops · Cauldron Mud · Cauldron Concrete · Ender Chest Always Drops ·
Glass Always Drops · Double Shulker Shells · Coordinates HUD · Durability Ping

**Confetti Creepers was deliberately removed.** It is not cosmetic: at its
default 100% chance every creeper explodes into confetti and does *no block
damage*, which removes creepers as a threat to your base.

---

## 5. PackBot integration

Code lives in this repo. Env vars on the **PackBot-Go** container:

| Variable | Value |
|---|---|
| `MC_ADDRESS` | `mc.thepck.com` |
| `MC_STATUS_CHANNEL_ID` | `1254040668590837771` |
| `MC_RCON_ADDRESS` | `192.168.1.16:25575` |
| `MC_RCON_PASSWORD` | in `server.properties` on grid |
| `MC_GUILD_ID` | `255258298230636545` |
| `MC_MAP_URL` | `https://map.thepck.com` |
| `MC_LOG_PATH` | `/mc-logs/latest.log` |
| `PTERO_URL` | Pterodactyl panel root |
| `PTERO_API_KEY` | **client** API key (`ptlc_…`), not an application key |
| `PTERO_SERVER_ID` | short server ID from the panel URL |

PackBot mounts the server's `logs/` directory **read-only** at `/mc-logs`.

The panel API is only used by `/mc wipe`, for the three things RCON cannot do:
stop the server in a way wings honours, delete the world, and edit
`server.properties` while it is down. Use a client key scoped to this server so
the bot can never touch anything else on the panel.

### Commands — `/mc`, guild-scoped

`status` · `whitelist` · `unwhitelist` · `leaderboard` · `deaths` ·
`advancements` · `whois` · `admin` (owner only) · `wipe` (owner only)

Whitelisting is self-service and enforces one Minecraft account per Discord user.

`/mc wipe confirm:PackCraft [seed:…] [pregen:true] [keep_map:false]` runs the
whole procedure in §8: refuses while anyone is online, backs up via the panel
and **aborts if the backup fails**, stops, deletes the world (keeping
`world/datapacks`), clears the BlueMap renders, writes the seed, restarts, waits
for RCON, re-applies `players_sleeping_percentage`, rolls the season, and
optionally starts Chunky. The confirm string is typed rather than a button
because a misclick must not be able to end a hardcore season.

**`keep_map:true` re-runs a season on the same seed without losing the map.**
Identical seed on an identical version generates identical terrain, so the
existing tiles stay correct: the map is complete the moment the server is back
rather than an hour later, and Chunky is skipped (`pregen` defaults to false).
It requires an explicit `seed` matching the current one and refuses otherwise —
a blank seed means a *new* random world, which would leave the map describing
terrain that no longer exists. The one wart is player builds: they are baked
into the tiles and linger as ghosts until someone regenerates that region.

### Background jobs

- **`MinecraftStatus`** — pings every 60s; announces up/down after 3 consecutive
  failures; credits playtime for players present across two consecutive polls.
- **`MinecraftLog`** — tails `latest.log` every 2s; posts joins, leaves,
  advancements and deaths; records deaths (with coordinates via RCON
  `LastDeathLocation`) and advancements, flagging first-to-earn.

### Tables

`MinecraftAccounts` · `MinecraftPlaytime` · `MinecraftDeaths` ·
`MinecraftAdvancements` · `MinecraftSeasons` — migrations 025–028, 030.

**Migration 030 is written but has not been run.** It adds season scoping so a
wipe doesn't blend worlds together on the boards. Until it runs, `/mc deaths`
and `/mc leaderboard` mix every season, and first-to-earn advancements read as
already claimed on day one of a new world. The storage layer is not season-aware
yet either.

### API

`GET /api/minecraft` (15s cache) · `GET /api/minecraft/deaths` (plottable points)

---

## 6. Runbook

### RCON from the shell

There is **no RCON client on the host or in the container**, and no Python
either. Use a throwaway container:

```bash
ssh grid 'D=/mnt/user/pterodactyl-node/data/f59a0d0b-4eaf-4164-b5ee-112e03039981
P=$(grep "^rcon.password=" $D/server.properties | cut -d= -f2-)
docker run --rm --network host -e RCON_HOST=192.168.1.16 -e RCON_PORT=25575 \
  -e RCON_PASSWORD="$P" itzg/rcon-cli "save-all flush"'
```

RCON is bound to `192.168.1.16`, **not loopback** — `127.0.0.1:25575` refuses.

### Backups

**Write to `/mnt/user/backups/minecraft/`.** Do *not* write to `/mnt/user/`
root: shfs treats top-level entries as shares, so a loose file there silently
lands on `/mnt/cache` and is invisible from `/mnt/user`.

```bash
ssh grid 'cd /mnt/user/pterodactyl-node/data && \
  tar -czf /mnt/user/backups/minecraft/mc-backup-$(date +%F-%H%M).tar.gz \
  f59a0d0b-4eaf-4164-b5ee-112e03039981'
```

Verify with `gzip -t`. Back up **with the server stopped** — a running backup
trips `file changed as we read it` on CoreProtect's database and that copy of
the DB is then inconsistent.

Restore: stop the server, `rm -rf` the directory, extract, `chown -R 100:101`.

### Stopping the server

**Use the Pterodactyl panel.** RCON `stop` works, but wings treats the exit as a
crash and restarts the server within seconds. Only a panel stop keeps it down.

### Pre-generating terrain

Use `shape square`, or a circle leaves black corners on the map:

```
chunky world world
chunky shape square
chunky radius 3000
chunky start
```

Radius 3000 is 142,129 chunks and takes ~15 minutes at ~350 chunks/sec. BlueMap
then renders it, which takes considerably longer and produces a few GB.

`chunky start` fails with "a task was already started" if a previous run was
paused; `chunky confirm` overrides it (discarding only the bookmark, never the
generated chunks).

The Nether wants a much smaller radius — 1 block there is 8 overworld blocks,
so `radius 1000` covers the same ground as 8000 in the overworld.

---

## 7. Gotchas — learned the hard way

### Config that fails silently

These produce **no error and no log line**. They just quietly don't work.

**`min-inhabited-time` must be `0`** in every `plugins/BlueMap/maps/*.conf`. At
any higher value BlueMap only renders chunks a player has physically walked
through, which makes Chunky pre-generation pointless and leaves the map looking
broken.

**`player-render-limit` must be `-1`** in `plugins/BlueMap/plugin.conf`. Despite
the name it is not a cap on player markers — it is a *pause threshold*. At `1`,
BlueMap stops rendering whenever one or more players are online, i.e. always.

**AxGraves `disabled-worlds` must not list real worlds.** The default is the
placeholder `blacklisted_world`. Listing `world`, `world_nether`,
`world_the_end` disables graves everywhere with no warning — you only find out
by dying.

**EssentialsX `disabled-commands`** silently surrenders the bare command name
while leaving `essentials:<command>` working. If `/gmc` "doesn't exist" but
`/essentials:gmc` does, check that list before assuming a version conflict.

**`pause-when-empty-seconds`** at any positive value stops the server ticking
when empty, which stops BlueMap catching up while nobody is online.

### Ecosystem and build

**Plugin ecosystem lag is real.** CoreProtect and EssentialsX both lag Paper
releases. Check compatibility before upgrading Minecraft — this server sat on
26.1.2 for a month for exactly that reason.

**CoreProtect from source needs a build flag.** `<project.branch>` is empty in
the pom; without it the plugin logs "Invalid plugin version (branch has not been
set)" and disables itself:

```bash
docker run --rm -v /mnt/user/appdata/cpbuild:/work -w /work \
  maven:3-eclipse-temurin-25 sh -c \
  "curl -sL https://github.com/PlayPro/CoreProtect/archive/refs/heads/master.tar.gz | tar xz \
   && cd CoreProtect-master && mvn -B package -DskipTests -Dproject.branch=development"
```

Confirm with `unzip -p target/CoreProtect-24.0.jar plugin.yml | grep branch` →
`branch: development`. Name the jar distinctly so nobody mistakes it for the
released 24.0.

**Paper's v2 download API is sunset.** The Pterodactyl egg's install script uses
it and will fail — **never press Reinstall**. Swap `server.jar` by hand from
`https://fill.papermc.io/v3/projects/paper/versions/<ver>/builds/<n>` and tick
*Skip Egg Install Script*.

### Server behaviour

**`server.properties` is rewritten on shutdown.** Edits made while the server is
running are silently reverted. Always edit while stopped.

**Escape sequences don't survive.** `\uXXXX` in the MOTD is normalised back to
raw bytes on save, and non-ASCII characters then get mangled. The `|` in the MOTD
is a pipe rather than `»` for exactly this reason. **Keep the MOTD ASCII.**

**Gamerules are snake_case in 26.x.** `playersSleepingPercentage` is now
`players_sleeping_percentage`; the old camelCase names are rejected outright.

**Dimensions live in one folder.** `world/dimensions/minecraft/{overworld,
the_nether,the_end}` — there are no `world_nether` / `world_the_end` folders, so
`rm -rf world/` clears all three dimensions in one step.

**ViaVersion makes `version.protocol` meaningless.** It echoes back the client's
own protocol number so the server never looks incompatible. Read `version.name`.

**`sample-count` must be ≥ `max-players`.** Playtime tracking reads the ping's
player sample; if it's capped lower, players beyond the cap look like they're
constantly joining and leaving.

**A running plugin can't be unloaded by deleting its jar.** BlueMapStructuresPaper
kept re-publishing markers every few seconds after removal until the server
restarted.

### BlueMap and the web path

**An idle SSE stream is indistinguishable from a broken one.** Cloudflare does
not flush response headers until the origin sends body bytes, and BlueMap's
`live/sse` sends nothing at all when no tiles are changing. So on a quiet
server this returns zero bytes and looks completely dead:

```bash
curl -sN -m 10 -D- https://map.thepck.com/maps/overworld/live/sse
```

Hours were lost to this. **Only test SSE while something is actually
happening.** The cheap way is to purge a small map and listen while it
re-renders:

```bash
# terminal 1
curl -sN -D- https://map.thepck.com/maps/world_the_end/live/sse
# terminal 2 — the End is tiny and re-renders in seconds
bluemap purge world_the_end
```

Working looks like `content-type: text/event-stream` followed by `event:`
lines. Note the origin *does* flush headers immediately, so comparing origin
against the public URL on an idle stream proves nothing — that mismatch is
expected, not a fault.

**The map is served straight from the tunnel to `192.168.1.16:8100`**, with no
NPM in the path. That's one hop fewer and worth keeping, but it was not
required to make SSE work.

**BlueMap map IDs don't match their dimensions.** `overworld` is the overworld,
but **`world` is the Nether** and `world_the_end` is the End. Display names are
set correctly, the IDs are legacy.

**All three map configs must set `world: "world"`** and distinguish themselves
with `dimension:` alone. Pointing a map at the dimension folder instead —
`world: "world/dimensions/minecraft/overworld"` — still renders terrain
perfectly, so it looks correct, but BlueMap can no longer match it to the Bukkit
world. The symptoms are indirect:

- players show `"foreign": true` in `live/players.json` and **never appear on
  that map**, even with `hide-different-world: false`
- that map alone loads no datapacks (it looks for them relative to the wrong
  root), visible in `bluemap/logs/debug.log`

Check with `curl -s http://127.0.0.1:8100/maps/overworld/live/players.json` —
`"foreign": false` is what you want. Fixing the path triggers a re-render.

**Purge the renders after a wipe.** Delete `bluemap/web/maps/*` and
`bluemap/tasks.dat`, or the new world inherits the old one's render state and
BlueMap reports "maps are updated" while showing stale or missing terrain.
Changing a render setting retroactively needs `bluemap purge <map>` too — a
plain `bluemap update` will not revisit regions it already considers done.

**Purge the Cloudflare cache after a wipe as well.** BlueMap serves tiles with
`Cache-Control: max-age=86400` and the tile paths are identical from one world
to the next, so Cloudflare's edge keeps serving the *previous* world's map to
everyone — including first-time visitors — for up to 24 hours. The files on
disk being correct proves nothing here; check with a cache-busting query
string, or just purge. Cloudflare dashboard → Caching → Configuration →
Purge Everything (or purge by hostname).

**A hard straight edge on the map is not a bug.** Region files are 512×512
blocks, so the limit of generated world renders as a perfect square edge. Black
beyond it is ungenerated world, not a broken tile.

**BlueMap settings are per-browser cookies** (`use-cookies: true`). Render
distance sliders live in ☰ → Settings → Render Distance; defaults are Hires 100,
Lowres 2000. Clearing cache doesn't reset them — clearing cookies does.

**Firefox needs working WebGL2.** A black canvas with a functioning UI and no
console errors is a graphics-stack problem, not a server one. Check
`about:support` → Graphics → *WebGL 2 Driver Renderer*.

---

## 8. Wiping and starting a new season

Hardcore seasons end when the group decides they have, which can be the same day
they started. Treat this as routine.

**`/mc wipe confirm:PackCraft` does all of this automatically** — prefer it. The
manual steps below are the fallback for when the panel API is unavailable, and
the reference for what the command is actually doing.

1. **Announce it.** A wipe is a group decision.
2. **Stop the server from the panel.**
3. **Back up** (§6) and verify with `gzip -t`. Keep the archive — a finished
   season is worth having.
4. **Stash the datapacks** — `world/datapacks/` dies with the world:
   ```bash
   cp $D/world/datapacks/*.zip /mnt/user/appdata/mcstage/datapacks/
   ```
5. Any `server.properties` changes go in now, while it's stopped.
6. `rm -rf $D/world` — takes all three dimensions.
7. Recreate `world/datapacks/` and copy the zips back.
8. **Purge BlueMap**: `rm -rf $D/bluemap/web/maps/*` and `rm -f $D/bluemap/tasks.dat`.
9. `chown -R 100:101 $D`
10. **Start from the panel.**
11. **Purge the Cloudflare cache** for `map.thepck.com`, or everyone keeps
    seeing the old world's map for up to 24 hours.
12. Re-apply the per-world gamerule: `gamerule players_sleeping_percentage 30`.
13. Verify hardcore actually took:
    ```bash
    zcat $D/world/level.dat | od -A n -t x1 -v | tr -d " \n" \
      | grep -oE "68617264636f7265.." 
    ```
    Trailing `01` is true, `00` is false.
14. Re-run Chunky (§6) if you want the map pre-generated.

### Rolling the PackBot season

Once migration 030 has been run, close the old season and open the next — the
unique index on `isCurrent` means the close must happen first:

```sql
UPDATE MinecraftSeasons SET endedAt = NOW() WHERE endedAt IS NULL;
INSERT INTO MinecraftSeasons (season, name, hardcore)
SELECT COALESCE(MAX(season), 0) + 1,
       CONCAT('Season ', COALESCE(MAX(season), 0) + 1, ' - Hardcore'), 1
  FROM MinecraftSeasons;
```

---

## 9. Monitoring

- **Uptime Kuma** — TCP check on `mc.thepck.com:25565`
- **PackBot** — posts to the Minecraft channel on up/down transitions

Both failures behind the original outage were monitoring gaps, not architecture
problems. Keep both.
