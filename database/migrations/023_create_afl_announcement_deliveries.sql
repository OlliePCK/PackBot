-- Restart-safe, per-guild delivery ledger for AFL announcements.
--
-- A claim is leased before Discord is called. Successful sends set sentAt;
-- failed sends release the claim so the next announcer tick can retry. The
-- kickoff timestamp is part of the identity because fixture times can move.
CREATE TABLE IF NOT EXISTS AflAnnouncementDeliveries (
    guildId VARCHAR(32) NOT NULL,
    announcementKind VARCHAR(32) NOT NULL,
    gameId VARCHAR(64) NOT NULL,
    kickoffUnix BIGINT NOT NULL,
    claimToken CHAR(32) DEFAULT NULL,
    claimedAt DATETIME DEFAULT NULL,
    sentAt DATETIME DEFAULT NULL,
    attemptCount INT UNSIGNED NOT NULL DEFAULT 0,
    lastError VARCHAR(512) DEFAULT NULL,
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (guildId, announcementKind, gameId, kickoffUnix),
    KEY idx_afl_announcement_pending (sentAt, claimedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
