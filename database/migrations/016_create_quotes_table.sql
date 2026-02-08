-- Migration: Create Quotes table for quote board

CREATE TABLE IF NOT EXISTS Quotes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guildId VARCHAR(32) NOT NULL,
    messageContent TEXT NOT NULL,
    authorId VARCHAR(32) NOT NULL,
    authorUsername VARCHAR(64) NOT NULL,
    savedBy VARCHAR(32) NOT NULL,
    channelId VARCHAR(32) DEFAULT NULL,
    messageId VARCHAR(32) DEFAULT NULL,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_guild (guildId),
    INDEX idx_author (guildId, authorId),
    INDEX idx_guild_created (guildId, createdAt DESC),
    FULLTEXT INDEX idx_content (messageContent)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
