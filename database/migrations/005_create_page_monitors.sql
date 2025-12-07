-- Migration: Create PageMonitors table
-- Stores page monitors for detecting website changes

CREATE TABLE IF NOT EXISTS PageMonitors (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guildId VARCHAR(32) NOT NULL,
    channelId VARCHAR(32) NOT NULL,
    createdBy VARCHAR(32) NOT NULL,
    name VARCHAR(100) NOT NULL,
    url TEXT NOT NULL,
    keywords TEXT DEFAULT NULL COMMENT 'Comma-separated keywords to trigger on (NULL = any change)',
    checkInterval INT DEFAULT 60 COMMENT 'Check interval in seconds',
    lastHash VARCHAR(64) DEFAULT NULL COMMENT 'MD5 hash of last content',
    lastChecked DATETIME DEFAULT NULL,
    lastChanged DATETIME DEFAULT NULL,
    roleToMention VARCHAR(32) DEFAULT NULL COMMENT 'Role ID to ping on change',
    isActive BOOLEAN DEFAULT TRUE,
    errorCount INT DEFAULT 0,
    lastError TEXT DEFAULT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_guild (guildId),
    INDEX idx_active (isActive),
    INDEX idx_next_check (isActive, lastChecked)
);
