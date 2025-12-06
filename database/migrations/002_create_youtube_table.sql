-- Migration: Create Youtube table
-- This table stores YouTube channel subscriptions for notifications

CREATE TABLE IF NOT EXISTS Youtube (
    id INT AUTO_INCREMENT PRIMARY KEY,
    handle VARCHAR(64) NOT NULL,
    channelId VARCHAR(64) NOT NULL,
    guildId VARCHAR(32) NOT NULL,
    lastCheckedVideo VARCHAR(64) DEFAULT NULL,
    initialized TINYINT(1) DEFAULT 0,
    lastChecked TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_channel_guild (channelId, guildId),
    INDEX idx_guild (guildId),
    INDEX idx_handle (handle)
);
