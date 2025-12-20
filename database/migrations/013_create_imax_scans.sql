-- Migration: Create IMAX scan cache table
-- Stores results of IMAX Melbourne seat availability scans

CREATE TABLE IF NOT EXISTS ImaxScanCache (
    id INT AUTO_INCREMENT PRIMARY KEY,
    scanDate DATE NOT NULL,
    numSeats INT NOT NULL DEFAULT 2,
    results JSON NOT NULL,
    scannedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    expiresAt DATETIME NOT NULL,
    INDEX idx_imax_date (scanDate),
    INDEX idx_imax_expires (expiresAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Optional: Track user watch requests for specific sessions/movies
CREATE TABLE IF NOT EXISTS ImaxWatches (
    id INT AUTO_INCREMENT PRIMARY KEY,
    odUserId VARCHAR(32) NOT NULL,
    guildId VARCHAR(32) NOT NULL,
    channelId VARCHAR(32) NOT NULL,
    movieName VARCHAR(200) NULL,
    sessionDate DATE NOT NULL,
    numSeats INT DEFAULT 2,
    isActive TINYINT(1) DEFAULT 1,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    lastNotified DATETIME NULL,
    INDEX idx_imax_user (odUserId),
    INDEX idx_imax_active (isActive, sessionDate),
    INDEX idx_imax_guild (guildId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
