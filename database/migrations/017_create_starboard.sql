-- Migration: Create Starboard table and add guild settings columns

CREATE TABLE IF NOT EXISTS Starboard (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guildId VARCHAR(32) NOT NULL,
    originalMessageId VARCHAR(32) NOT NULL,
    starboardMessageId VARCHAR(32) DEFAULT NULL,
    channelId VARCHAR(32) NOT NULL COMMENT 'Channel of the original message',
    authorId VARCHAR(32) NOT NULL,
    content TEXT DEFAULT NULL,
    attachmentUrl TEXT DEFAULT NULL,
    starCount INT DEFAULT 0,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_original (guildId, originalMessageId),
    INDEX idx_guild_stars (guildId, starCount DESC),
    INDEX idx_guild_created (guildId, createdAt DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE Guilds ADD COLUMN starboardChannelID VARCHAR(32) DEFAULT NULL;
ALTER TABLE Guilds ADD COLUMN starThreshold INT DEFAULT 3;
