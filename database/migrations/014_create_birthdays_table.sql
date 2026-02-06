-- Migration: Create Birthdays table
-- This table stores birthday dates for guild members for daily reminders

CREATE TABLE IF NOT EXISTS Birthdays (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guildId VARCHAR(32) NOT NULL,
    userId VARCHAR(32) NOT NULL,
    name VARCHAR(100) NOT NULL,
    birthMonth TINYINT NOT NULL,
    birthDay TINYINT NOT NULL,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_user_guild (userId, guildId),
    INDEX idx_guild (guildId),
    INDEX idx_birthday (birthMonth, birthDay)
);
