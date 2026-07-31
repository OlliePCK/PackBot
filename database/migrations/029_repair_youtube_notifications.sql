-- Restart-safe YouTube notification delivery ledger and a subscription
-- timestamp for legacy production tables created before the Go migrations.
ALTER TABLE Youtube
    ADD COLUMN IF NOT EXISTS createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_youtube_channel_guild
    ON Youtube (channelId, guildId);

CREATE TABLE IF NOT EXISTS YoutubeNotificationDeliveries (
    guildId VARCHAR(32) NOT NULL,
    notifyChannelId VARCHAR(32) NOT NULL,
    youtubeChannelId VARCHAR(64) NOT NULL,
    videoId VARCHAR(64) NOT NULL,
    publishedAt DATETIME NOT NULL,
    claimToken CHAR(32) DEFAULT NULL,
    claimedAt DATETIME DEFAULT NULL,
    sentAt DATETIME DEFAULT NULL,
    skippedAt DATETIME DEFAULT NULL,
    skipReason VARCHAR(64) DEFAULT NULL,
    discordMessageId VARCHAR(32) DEFAULT NULL,
    attemptCount INT UNSIGNED NOT NULL DEFAULT 0,
    lastError VARCHAR(512) DEFAULT NULL,
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (notifyChannelId, youtubeChannelId, videoId),
    KEY idx_youtube_delivery_pending (sentAt, skippedAt, claimedAt),
    KEY idx_youtube_delivery_published (youtubeChannelId, publishedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
