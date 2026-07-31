-- Links a Discord user to their Minecraft username so playtime can be
-- attributed to the existing Playtime table (gameName = 'Minecraft') and so
-- whitelisting can follow Discord roles.
--
-- mcUsername is UNIQUE per guild: two Discord accounts must not be able to
-- claim the same Minecraft account, or whitelist-by-role becomes a way to
-- grant someone else access. The utf8mb4_unicode_ci collation makes that
-- check case-insensitive, matching Mojang's own username uniqueness.
CREATE TABLE IF NOT EXISTS MinecraftAccounts (
    guildId VARCHAR(32) NOT NULL,
    odUserId VARCHAR(32) NOT NULL,
    mcUsername VARCHAR(16) NOT NULL,
    whitelisted TINYINT(1) NOT NULL DEFAULT 0,
    linkedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (guildId, odUserId),
    UNIQUE KEY uniq_minecraft_username (guildId, mcUsername)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
