-- AFL predictions feature (Go bot Phase 2): per-guild announcement channel
-- (set via /settings set-afl-channel; NULL = feature off for the guild) and
-- the last round posted there (restart-safe weekly-post dedupe).
ALTER TABLE Guilds
    ADD COLUMN aflChannelID VARCHAR(32) NULL,
    ADD COLUMN aflLastRound VARCHAR(64) NULL;
