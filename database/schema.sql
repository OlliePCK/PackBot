-- PackBot Database Schema
-- Run this file to create all tables from scratch
-- Compatible with MySQL 5.7+ / MariaDB 10.2+

-- ============================================
-- Guilds Table
-- Stores server-specific settings
-- ============================================
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Youtube Table
-- Stores YouTube channel subscriptions for notifications
-- ============================================
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Playtime Table
-- Tracks user gaming sessions for leaderboards
-- ============================================
CREATE TABLE IF NOT EXISTS Playtime (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guildId VARCHAR(32) NOT NULL,
    odUserId VARCHAR(32) NOT NULL,
    odUsername VARCHAR(64) NOT NULL,
    gameName VARCHAR(128) NOT NULL,
    totalSeconds BIGINT DEFAULT 0,
    lastPlayed TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_user_game (guildId, odUserId, gameName),
    INDEX idx_guild_time (guildId, totalSeconds DESC),
    INDEX idx_user (odUserId),
    INDEX idx_game (gameName)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
