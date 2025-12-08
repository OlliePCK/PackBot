-- Add 24/7 mode setting to Guilds table
-- When enabled, bot stays in voice channel even when alone

ALTER TABLE Guilds ADD COLUMN twentyFourSevenMode TINYINT(1) DEFAULT 0;
