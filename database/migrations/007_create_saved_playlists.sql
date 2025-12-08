-- SavedPlaylists table for storing user's favorite playlists
-- Users can save Spotify, YouTube, or SoundCloud playlists for quick access

CREATE TABLE IF NOT EXISTS SavedPlaylists (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guildId VARCHAR(32) NOT NULL,
    userId VARCHAR(32) NOT NULL,
    name VARCHAR(50) NOT NULL,
    url TEXT NOT NULL,
    platform VARCHAR(20) DEFAULT 'unknown',
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_user_playlist (guildId, userId, name),
    INDEX idx_guild_user (guildId, userId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
