-- Migration: Create ListeningHistory table for tracking played songs
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
