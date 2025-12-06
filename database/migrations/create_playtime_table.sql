-- Create Playtime table to track user gaming sessions
CREATE TABLE IF NOT EXISTS Playtime (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guildId VARCHAR(32) NOT NULL,
    odUserId VARCHAR(32) NOT NULL,
    odUsername VARCHAR(64) NOT NULL,
    gameName VARCHAR(128) NOT NULL,
    totalSeconds BIGINT DEFAULT 0,
    lastPlayed TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_user_game (guildId, odUserId, gameName),
    INDEX idx_guild_time (guildId, totalSeconds DESC)
);
