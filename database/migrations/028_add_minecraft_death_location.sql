-- Death coordinates, read from the player's LastDeathLocation NBT after the
-- log reports a death.
--
-- Nullable on purpose: the lookup needs the player to still be connected, and
-- someone who dies and immediately quits leaves no position behind. A death
-- without coordinates still counts on the leaderboard.
ALTER TABLE MinecraftDeaths
    ADD COLUMN IF NOT EXISTS x INT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS y INT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS z INT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS dimension VARCHAR(64) DEFAULT NULL;
