-- Migration: Create VoiceWhitelist table
-- Stores guilds allowed to use voice commands (Deepgram API costs)

CREATE TABLE IF NOT EXISTS VoiceWhitelist (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guildId VARCHAR(32) NOT NULL UNIQUE,
    addedBy VARCHAR(32) NOT NULL,
    guildName VARCHAR(100) DEFAULT NULL,
    addedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_guild (guildId)
);

-- Pre-populate with owner's guilds
INSERT IGNORE INTO VoiceWhitelist (guildId, addedBy, guildName) VALUES 
    ('773732791585865769', '101784904152395776', 'Charged Cops'),
    ('255258298230636545', '101784904152395776', 'The Pack');
