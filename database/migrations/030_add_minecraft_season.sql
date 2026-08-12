-- Season scoping for the Minecraft history tables.
--
-- The 2026-08-10 hardcore wipe replaced the world. Playtime, deaths and
-- advancements are facts about a world, not about a player: without a season
-- marker the new world's leaderboard inherits season 1's totals, and every
-- "first to earn" advancement is already claimed before anyone logs in.
--
-- Existing rows default to season 1, which is what they are.
--
-- MinecraftAccounts is deliberately left alone. A Discord-to-Minecraft link is
-- a fact about a person, and the whitelist is meant to survive a wipe.

-- The current season is the one that has not ended. isCurrent is NULL for any
-- closed season, and MySQL does not apply UNIQUE to NULLs, so this index reads
-- as "at most one season may be open at a time" — worth enforcing in the
-- schema, because two open seasons would silently split every leaderboard.
CREATE TABLE IF NOT EXISTS MinecraftSeasons (
    season INT NOT NULL,
    name VARCHAR(64) NOT NULL,
    hardcore TINYINT(1) NOT NULL DEFAULT 0,
    startedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    endedAt TIMESTAMP NULL DEFAULT NULL,
    isCurrent TINYINT(1) AS (IF(endedAt IS NULL, 1, NULL)) VIRTUAL,
    PRIMARY KEY (season),
    UNIQUE KEY uniq_minecraft_season_current (isCurrent)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Season 1's start is not recorded anywhere, so it is derived from the
-- earliest playtime row — the first time anyone was seen on the server. The
-- end is when the world directory was deleted.
INSERT IGNORE INTO MinecraftSeasons (season, name, hardcore, startedAt, endedAt)
SELECT 1,
       'Season 1 - Survival',
       0,
       COALESCE((SELECT MIN(firstSeenAt) FROM MinecraftPlaytime), '2026-01-23 00:00:00'),
       '2026-08-10 17:47:00';

-- Season 2 is the hardcore world that is actually live, created 2026-08-12
-- 13:03:29.
--
-- Several hardcore worlds were generated and discarded on 2026-08-10/11 while
-- the server config was being repaired. The handful of rows they produced fall
-- inside season 1's range and stay there: they belong to no world that still
-- exists, and inventing a season per abandoned attempt would make the boards
-- less readable, not more accurate.
INSERT IGNORE INTO MinecraftSeasons (season, name, hardcore, startedAt, endedAt)
VALUES (2, 'Season 2 - Hardcore', 1, '2026-08-12 13:03:29', NULL);

-- Rolling a season is a routine operation in hardcore, not a schema change:
-- a permadeath world can end the same day it started. To close the current
-- season and open the next one, run these two statements together. The unique
-- index on isCurrent means the close must happen first.
--
--   UPDATE MinecraftSeasons SET endedAt = NOW() WHERE endedAt IS NULL;
--   INSERT INTO MinecraftSeasons (season, name, hardcore)
--   SELECT COALESCE(MAX(season), 0) + 1,
--          CONCAT('Season ', COALESCE(MAX(season), 0) + 1, ' - Hardcore'),
--          1
--     FROM MinecraftSeasons;

ALTER TABLE MinecraftPlaytime
    ADD COLUMN IF NOT EXISTS season INT NOT NULL DEFAULT 1;

-- The primary key has to carry the season. Left as (mcUsername), the upsert in
-- RecordMinecraftPlaytime would keep accumulating onto season 1's row and the
-- new season could never start from zero.
ALTER TABLE MinecraftPlaytime
    DROP PRIMARY KEY;
ALTER TABLE MinecraftPlaytime
    ADD PRIMARY KEY (season, mcUsername);

ALTER TABLE MinecraftDeaths
    ADD COLUMN IF NOT EXISTS season INT NOT NULL DEFAULT 1;
ALTER TABLE MinecraftDeaths
    DROP KEY IF EXISTS idx_minecraft_deaths_season;
ALTER TABLE MinecraftDeaths
    ADD KEY idx_minecraft_deaths_season (season, diedAt);

ALTER TABLE MinecraftAdvancements
    ADD COLUMN IF NOT EXISTS season INT NOT NULL DEFAULT 1;

-- Same reasoning as playtime. With (mcUsername, advancement) as the key an
-- advancement is earned permanently, so the INSERT IGNORE that keeps recording
-- idempotent would also silently discard season 2's earning of it.
ALTER TABLE MinecraftAdvancements
    DROP PRIMARY KEY;
ALTER TABLE MinecraftAdvancements
    ADD PRIMARY KEY (season, mcUsername, advancement);

-- The first-to-earn race is per season, so the index that serves it must lead
-- with the season.
ALTER TABLE MinecraftAdvancements
    DROP KEY IF EXISTS idx_minecraft_advancements_race;
ALTER TABLE MinecraftAdvancements
    ADD KEY idx_minecraft_advancements_race (season, advancement, earnedAt);
