# PackBot

PackBot is a versatile Discord bot designed to enhance your server with music playback, playtime tracking, YouTube notifications, streaming alerts, and more. Built with Discord.js v14 and a custom yt-dlp audio system.

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
| `/undo` | Restore the last removed track |
| `/filters [filter]` | Apply audio filters (bassboost, nightcore, etc.) |
| `/leave` | Disconnect from voice channel |

**Supported Sources:**
- YouTube (videos, playlists, search)
- Spotify (tracks, albums, playlists - converted via YouTube)
- Direct URLs (any yt-dlp supported source)

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
   
   # Optional: Logging
   LOG_LEVEL=info          # debug, info, warn, error
   LOG_FORMAT=text         # text, json
   LOG_COLORS=false        # true/false
   LOG_DIR=logs
   LOG_MAX_SIZE_MB=5
   LOG_MAX_FILES=5
   ```

4. **Set up the database:**
   
   Run the migrations in `database/migrations/` or create tables manually.

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
1. Add container from Docker Hub: `olliepck/packbot:latest`
2. Add environment variables in container settings
3. Mount `/usr/src/app/logs` for persistent logs
4. Mount `cookies.json` if needed for age-restricted videos

## Project Structure
```
PackBot/
├── commands/           # Slash command handlers
├── database/           # Database connection and migrations
├── events/
│   ├── client/         # Discord.js event handlers
│   └── event-functions/ # Background services (game-expose, live-noti)
├── music/              # Music system (Subscription, Track, QueryResolver)
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