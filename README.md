# PackBot

PackBot is a versatile Discord bot designed to enhance your server with music playback, voice commands, page monitoring, playtime tracking, YouTube notifications, streaming alerts, and more. Built with Discord.js v14 and a custom yt-dlp audio system.

## Features

### 🎵 Music System
Full-featured music playback using yt-dlp and @discordjs/voice.

| Command | Description |
|---------|-------------|
| `/play <query>` | Play a song from YouTube, Spotify, or direct URL |
| `/pause` | Pause/resume playback |
| `/stop` | Stop playback and clear queue |
| `/skip` | Skip to the next track |
| `/previous` | Play the previous track from history |
| `/queue` | View the current queue (paginated) |
| `/shuffle` | Shuffle the queue |
| `/repeat <off\|song\|queue>` | Set repeat mode |
| `/autoplay` | Toggle autoplay related songs |
| `/volume <0-200>` | Adjust playback volume |
| `/seek <time>` | Seek to a timestamp (e.g., 1:30) |
| `/jump <position>` | Jump to a specific queue position |
| `/swap <pos1> <pos2>` | Swap two tracks in the queue |
| `/push <position>` | Move a track to the front |
| `/undo` | Remove the last added track |
| `/filters [filter]` | Apply audio filters (bassboost, nightcore, etc.) |
| `/join` | Join your voice channel |
| `/leave` | Disconnect from voice channel |

**Supported Sources:**
- YouTube (videos, playlists, search)
- Spotify (tracks, albums, playlists - converted via YouTube)
- Direct URLs (any yt-dlp supported source)

### 🎤 Voice Commands
Control the music bot hands-free using voice commands powered by Deepgram speech recognition.

| Command | Description |
|---------|-------------|
| `/voice enable` | Enable voice commands in your channel |
| `/voice disable` | Disable voice commands |
| `/voice status` | Check voice command status |
| `/voice autoenable <on\|off>` | Auto-enable voice commands when bot joins (Admin) |

**Voice Commands (say "Pack Bot" followed by):**
- `play [song name]` - Queue a song
- `skip` / `next` - Skip current track
- `stop` - Stop playback and clear queue
- `pause` / `resume` - Pause/resume playback
- `volume [0-200]` - Set volume level
- `previous` - Play previous track
- `shuffle` - Shuffle the queue

> **Note:** Voice commands require server whitelisting (paid Deepgram API). Contact the bot owner to enable for your server.

### 🔍 Page Monitor
Monitor websites for changes and get notified when specific content appears. Perfect for tracking restocks, ticket drops, or any webpage updates.

| Command | Description |
|---------|-------------|
| `/monitor add <url> <name>` | Add a new page monitor |
| `/monitor remove <name>` | Remove a monitor |
| `/monitor list` | List all monitors in this server |
| `/monitor pause <name>` | Pause a monitor |
| `/monitor resume <name>` | Resume a paused monitor |
| `/monitor test <name>` | Test a monitor immediately |
| `/monitor info <name>` | View detailed monitor info |
| `/monitor help` | Show usage guide |

**Monitor Options:**
- `interval` - Check frequency (60-3600 seconds, default: 300)
- `keywords` - Only alert when these words appear (comma-separated)
- `role` - Role to ping on changes
- `channel` - Channel for notifications (defaults to current)

### 📊 Playtime Tracking & Leaderboards
Track how long members play games and compete on leaderboards.

| Command | Description |
|---------|-------------|
| `/leaderboard total` | Top players by total playtime |
| `/leaderboard game <name>` | Top players for a specific game |
| `/leaderboard user [member]` | A user's most played games |
| `/leaderboard games` | Most played games in the server |

### 📺 YouTube Notifications
Automatic notifications when subscribed YouTube channels upload new videos.

| Command | Description |
|---------|-------------|
| `/youtube add <handle>` | Subscribe to a YouTube channel |
| `/youtube remove <handle>` | Unsubscribe from a channel |
| `/youtube list` | List all subscriptions |

### 🎮 Event Functions
Automatic notifications and tracking:

- **Game Expose**: Announces when someone plays a game for 6+ hours
- **Live Notifications**: Alerts when members start streaming on Discord

### 🛒 Shopify Integration
| Command | Description |
|---------|-------------|
| `/shopify <url>` | Scrape product data from Shopify stores |

### ⚙️ Server Settings
| Command | Description |
|---------|-------------|
| `/settings info` | View current bot settings |
| `/settings set-live-channel` | Set channel for stream notifications |
| `/settings set-general-channel` | Set general announcement channel |
| `/settings set-live-role` | Set role for stream mentions |
| `/settings set-youtube-channel` | Set channel for YouTube notifications |

### 🛠️ Utility
| Command | Description |
|---------|-------------|
| `/ping` | Check bot latency |
| `/purge <amount>` | Bulk delete messages |

## Getting Started

### Prerequisites
- Node.js v22+
- npm
- Discord bot token
- MySQL/MariaDB database
- yt-dlp (installed automatically in Docker)
- ffmpeg

### Installation

1. **Clone the repository:**
   ```sh
   git clone https://github.com/OlliePCK/PackBot.git
   cd PackBot
   ```

2. **Install dependencies:**
   ```sh
   npm install
   ```

3. **Configure environment variables:**
   
   Create a `.env` file:
   ```env
   # Discord
   TOKEN=your_discord_bot_token
   CLIENT_ID=your_client_id
   
   # Database
   MYSQL_HOST=your_mysql_host
   MYSQL_PORT=3306
   MYSQL_USER=your_mysql_user
   MYSQL_PASSWORD=your_mysql_password
   MYSQL_DB=your_mysql_database
   
   # APIs (Optional)
   YOUTUBE_API_KEY=your_youtube_api_key      # For YouTube notifications
   DEEPGRAM_API_KEY=your_deepgram_api_key    # For voice commands
   SPOTIFY_CLIENT_ID=your_spotify_client_id  # For Spotify support
   SPOTIFY_CLIENT_SECRET=your_spotify_secret
   
   # Logging (Optional)
   LOG_LEVEL=info          # debug, info, warn, error
   LOG_FORMAT=text         # text, json
   LOG_COLORS=false        # true/false
   LOG_DIR=logs
   LOG_MAX_SIZE_MB=5
   LOG_MAX_FILES=5
   ```

4. **Set up the database:**
   
   Option A - Run the migration script:
   ```sh
   node database/migrate.js
   ```
   
   Option B - Run the full schema manually:
   ```sh
   mysql -u your_user -p your_database < database/schema.sql
   ```
   
   This creates the following tables:
   - `Guilds` - Server settings (channels, roles, voice command preferences)
   - `Youtube` - YouTube channel subscriptions
   - `Playtime` - User gaming session tracking
   - `VoiceWhitelist` - Servers enabled for voice commands
   - `PageMonitors` - Page monitor configurations

5. **Deploy slash commands:**
   ```sh
   node deploy-commands.js
   ```

6. **Start the bot:**
   ```sh
   node index.js
   ```

## Docker Deployment

### Build and run locally:
```sh
docker build -t packbot .
docker run --env-file .env packbot
```

### Pull from Docker Hub:
```sh
docker pull olliepck/packbot:latest
```

### CI/CD (Automatic DockerHub builds)
This repo includes a GitHub Actions workflow that builds and pushes the PackBot image to DockerHub on every push to `master`/`main` (`.github/workflows/docker-image.yml`).

1. Create a DockerHub access token (Account Settings → Security → New Access Token).

## CI/CD Overview (PackBot + PackSite)

You have two separate deployment processes:

### 1) PackBot (Docker image → DockerHub)
This repo builds and pushes the Docker image to DockerHub via:
- `.github/workflows/docker-image.yml`

**Required GitHub secrets:**
- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

On Unraid you can then pull/update the container using the Unraid Docker UI (or an auto-updater if you prefer).

### 2) PackSite (files → nginx directory on Unraid)
PackSite deploy is done locally (Windows) via a script that runs `vite build` and then uploads the `dist/` output via `scp` to:
`/mnt/user/appdata/binhex-nginx/nginx/html/the-pack/`

**One-time setup:**
```powershell
Copy-Item .\scripts\deploy.config.example.json .\scripts\deploy.config.json
```
Edit `scripts/deploy.config.json` and set `host`, `user`, and `targetPath`.

**Deploy:**
```powershell
./scripts/deploy-packsite.ps1
```

Notes:
- Requires Node.js/npm on your PC.
- Requires `scp` (Windows OpenSSH client).


2. In GitHub → Repo Settings → Secrets and variables → Actions, add:
   - `DOCKERHUB_USERNAME` = your DockerHub username
   - `DOCKERHUB_TOKEN` = your DockerHub access token
3. Push to `master` (or `main`). A new image is published as:
   - `<username>/packbot:latest`
   - `<username>/packbot:sha-<commit>`
4. On Unraid, point the container to `<username>/packbot:latest` and enable automatic updates via CA Auto Update Applications or watchtower.

### Docker Compose example:
```yaml
version: '3.8'
services:
  packbot:
    image: olliepck/packbot:latest
    restart: unless-stopped
    environment:
      - TOKEN=${TOKEN}
      - CLIENT_ID=${CLIENT_ID}
      - MYSQL_HOST=${MYSQL_HOST}
      - MYSQL_PORT=${MYSQL_PORT}
      - MYSQL_USER=${MYSQL_USER}
      - MYSQL_PASSWORD=${MYSQL_PASSWORD}
      - MYSQL_DB=${MYSQL_DB}
    volumes:
      - ./logs:/usr/src/app/logs
      - ./cookies.json:/usr/src/app/cookies.json:ro
```

### Unraid Setup:
Template available at `unraid/my-PackBot.xml`.

1. Add container from Docker Hub: `olliepck/packbot:latest`
2. Add environment variables in container settings
3. Mount `/app/logs` for persistent logs
4. Mount `cookies.json` if needed for age-restricted videos

## Project Structure
```
PackBot/
├── commands/           # Slash command handlers
├── database/           # Database connection and migrations
│   ├── db.js           # Connection pool
│   ├── schema.sql      # Full database schema
│   └── migrations/     # Incremental migrations
├── events/
│   ├── client/         # Discord.js event handlers
│   └── event-functions/ # Background services (game-expose, live-noti)
├── music/              # Music system
│   ├── Subscription.js # Audio player and queue management
│   ├── Track.js        # Track model
│   ├── QueryResolver.js # YouTube/Spotify/URL resolution
│   └── VoiceCommandListener.js # Deepgram voice recognition
├── services/           # Background services
│   └── PageMonitorService.js # Website change detection
├── scripts/            # Background scripts (YouTube notifications)
├── logs/               # Log files (auto-created)
├── index.js            # Main entry point
├── logger.js           # Structured logging system
└── Dockerfile          # Docker configuration
```

## Contributing
Contributions are welcome! Please fork the repository and create a pull request with your changes.

## License
This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
