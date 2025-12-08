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
    voiceCommandsEnabled TINYINT(1) DEFAULT 0,
    twentyFourSevenMode TINYINT(1) DEFAULT 0,
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

-- ============================================
-- VoiceWhitelist Table
-- Stores guilds allowed to use voice commands (Deepgram API)
-- ============================================
CREATE TABLE IF NOT EXISTS VoiceWhitelist (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guildId VARCHAR(32) NOT NULL UNIQUE,
    addedBy VARCHAR(32) NOT NULL,
    guildName VARCHAR(100) DEFAULT NULL,
    addedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_guild (guildId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- PageMonitors Table
-- Stores page monitors for detecting website changes
-- ============================================
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- SavedPlaylists Table
-- Stores user's saved playlists for quick access
-- ============================================
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

-- ============================================
-- UserPreferences Table
-- Stores user-specific settings for the web dashboard
-- ============================================
CREATE TABLE IF NOT EXISTS UserPreferences (
    id INT AUTO_INCREMENT PRIMARY KEY,
    odUserId VARCHAR(32) NOT NULL UNIQUE,
    favoriteGuildId VARCHAR(32) DEFAULT NULL,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user (odUserId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- ListeningHistory Table
-- Tracks all songs played across servers
-- ============================================
CREATE TABLE IF NOT EXISTS ListeningHistory (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guildId VARCHAR(32) NOT NULL,
    odUserId VARCHAR(32) NOT NULL COMMENT 'User who requested the song',
    odUsername VARCHAR(64) NOT NULL,
    trackTitle VARCHAR(255) NOT NULL,
    trackArtist VARCHAR(255) DEFAULT NULL,
    trackUrl TEXT DEFAULT NULL,
    trackThumbnail TEXT DEFAULT NULL,
    durationSeconds INT DEFAULT 0,
    playedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_guild (guildId),
    INDEX idx_user (odUserId),
    INDEX idx_played (playedAt DESC),
    INDEX idx_guild_played (guildId, playedAt DESC),
    INDEX idx_user_played (odUserId, playedAt DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
