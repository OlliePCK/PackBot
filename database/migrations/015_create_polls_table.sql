-- Migration: Create Polls table for quick polls

CREATE TABLE IF NOT EXISTS Polls (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guildId VARCHAR(32) NOT NULL,
    channelId VARCHAR(32) NOT NULL,
    messageId VARCHAR(32) DEFAULT NULL,
    question VARCHAR(500) NOT NULL,
    options JSON NOT NULL COMMENT 'Array of option strings',
    votes JSON NOT NULL DEFAULT ('{}') COMMENT 'Object: optionIndex -> array of userId strings',
    createdBy VARCHAR(32) NOT NULL,
    expiresAt DATETIME NOT NULL,
    closed TINYINT(1) DEFAULT 0,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_guild (guildId),
    INDEX idx_expires (closed, expiresAt),
    INDEX idx_message (messageId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
