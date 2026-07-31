-- Death and advancement history, derived from the server log.
--
-- Keyed on the in-game username for the same reason as MinecraftPlaytime:
-- everyone who plays should count, not only players who linked a Discord
-- account.

CREATE TABLE IF NOT EXISTS MinecraftDeaths (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    mcUsername VARCHAR(16) NOT NULL,
    -- The message with the player's name stripped: "was slain by Enderman".
    cause VARCHAR(255) NOT NULL,
    diedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_minecraft_deaths_user (mcUsername),
    KEY idx_minecraft_deaths_time (diedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per player per advancement. The composite primary key makes
-- recording idempotent: re-reading a log line (after a rotation, say) cannot
-- double-count, and "first to earn X" stays truthful.
CREATE TABLE IF NOT EXISTS MinecraftAdvancements (
    mcUsername VARCHAR(16) NOT NULL,
    advancement VARCHAR(128) NOT NULL,
    earnedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (mcUsername, advancement),
    KEY idx_minecraft_advancements_race (advancement, earnedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
