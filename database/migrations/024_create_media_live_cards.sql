-- Restart-safe delivery state for the main-guild Jellyfin Live TV card.
--
-- A row is claimed before Discord is called. Pending rows deliberately fail
-- closed after a crash: without a Discord message ID the bot cannot prove
-- whether the send succeeded, so it must not risk posting a duplicate.
CREATE TABLE IF NOT EXISTS MediaLiveCards (
    guildId VARCHAR(32) NOT NULL,
    jellyfinChannelId VARCHAR(64) NOT NULL,
    discordChannelId VARCHAR(32) NOT NULL,
    discordMessageId VARCHAR(32) DEFAULT NULL,
    status ENUM('pending', 'active') NOT NULL DEFAULT 'pending',
    firstSeenAt DATETIME(6) NOT NULL,
    lastSeenAt DATETIME(6) NOT NULL,
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (guildId, jellyfinChannelId),
    KEY idx_media_live_cards_status (guildId, status, lastSeenAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
