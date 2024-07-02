# PackBot

PackBot is a versatile Discord bot designed to enhance your server with music playback, Shopify data scraping, and customizable settings. Additionally, it features event functions to notify when users are streaming or playing games for extended periods.

## Features

### Music Bot Commands
- **play**: Plays a song from a URL or search query.
- **pause**: Pauses the current song.
- **stop**: Stops the music and clears the queue.
- **push**: Adds a song to the top of the queue.
- **queue**: Displays the current song queue.
- **repeat**: Repeats the current song or queue.
- **seek**: Jumps to a specific timestamp in the current song.
- **skip**: Skips to the next song in the queue.
- **shuffle**: Shuffles the current queue.
- **undo**: Reverts the last action.
- **volume**: Adjusts the playback volume.
- **filter**: Applies audio filters to the playback.
- **swap**: Swaps the positions of two songs in the queue.
- **previous**: Plays the previous song.
- **leave**: Disconnects the bot from the voice channel.
- **jump**: Jumps to a specific song in the queue.

### Shopify Scraping
- **shopify**: Scrapes data from a Shopify store.

### Bot Settings
- **settings info**: Displays current bot settings.
- **settings set-live-channel**: Sets the channel for live notifications.
- **settings set-general-channel**: Sets the general announcement channel.
- **settings set-live-role**: Sets the role to be mentioned in live notifications.

### Event Functions
- **game_expose**: Notifies when users have been playing a game for too long.
- **live_noti**: Sends a notification when a guild member starts a livestream on Twitch/YouTube.

## Getting Started

### Prerequisites

- Node.js
- npm (Node Package Manager)
- A Discord bot token
- A MySQL database

### Installation

1. Clone the repository:

   ```sh
   git clone https://github.com/your-username/packbot.git
   cd packbot
   ```

2. Install dependencies:

   ```sh
   npm install
   ```

3. Set up your `.env` file:

   Create a file named `.env` in the root directory of your project and add the following variables:

   ```env
   TOKEN=<your_discord_bot_token>
   CLIENT_ID=<your_client_id>
   MYSQL_HOST=<your_mysql_host>
   MYSQL_PORT=<your_mysql_port>
   MYSQL_USER=<your_mysql_user>
   MYSQL_PASSWORD=<your_mysql_password>
   MYSQL_DB=<your_mysql_database>
   ```

4. Set up the database connection pool in `database.js`:

   ```js
   const mysql = require('mysql2/promise');
   require('dotenv').config();

   const pool = mysql.createPool({
       host: process.env.MYSQL_HOST,
       user: process.env.MYSQL_USER,
       port: process.env.MYSQL_PORT,
       password: process.env.MYSQL_PASSWORD,
       database: process.env.MYSQL_DB,
       waitForConnections: true,
       connectionLimit: 10,
       maxIdle: 10,
       idleTimeout: 60000,
       queueLimit: 0,
       enableKeepAlive: true,
       keepAliveInitialDelay: 0,
   });

   exports.pool = pool;
   ```

5. Start the bot:

   ```sh
   node index.js
   ```

## Usage

Once the bot is running, you can invite it to your Discord server using the OAuth2 URL generated from the Discord Developer Portal. Use the commands listed above to interact with the bot.

## Contributing

Contributions are welcome! Please fork the repository and create a pull request with your changes.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.