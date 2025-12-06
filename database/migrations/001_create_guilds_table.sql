-- Migration: Create Guilds table
-- This table stores server-specific settings for each Discord guild

CREATE TABLE IF NOT EXISTS Guilds (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guildId VARCHAR(32) NOT NULL UNIQUE,
    liveRoleID VARCHAR(32) DEFAULT NULL,
    liveChannelID VARCHAR(32) DEFAULT NULL,
    generalChannelID VARCHAR(32) DEFAULT NULL,
    youtubeChannelID VARCHAR(32) DEFAULT NULL,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_guild (guildId)
);
