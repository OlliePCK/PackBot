-- Minecraft playtime, keyed on the in-game username rather than a Discord
-- user.
--
-- Deliberately independent of MinecraftAccounts: the leaderboard should count
-- everyone who plays, including anyone whitelisted manually by an admin who
-- never ran /mc whitelist. Tying it to a Discord link would silently drop
-- those players.
--
-- Not guild-scoped — there is one Minecraft server, and its players are its
-- players.
CREATE TABLE IF NOT EXISTS MinecraftPlaytime (
    mcUsername VARCHAR(16) NOT NULL,
    totalSeconds BIGINT UNSIGNED NOT NULL DEFAULT 0,
    firstSeenAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lastSeenAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (mcUsername),
    KEY idx_minecraft_playtime_total (totalSeconds)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
