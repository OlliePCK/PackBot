-- Migration: Add performance indexes for listening history queries

ALTER TABLE ListeningHistory ADD INDEX idx_guild_user (guildId, odUserId);
ALTER TABLE ListeningHistory ADD INDEX idx_guild_artist (guildId, trackArtist);
ALTER TABLE ListeningHistory ADD INDEX idx_guild_track_title (guildId, trackTitle(100));
