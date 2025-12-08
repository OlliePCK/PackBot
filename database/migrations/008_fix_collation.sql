-- Migration: Fix collation mismatch between tables
-- The SavedPlaylists table needs to use the same collation as Guilds

-- First, alter the SavedPlaylists table to use utf8mb4_unicode_ci
ALTER TABLE SavedPlaylists 
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Also ensure all string columns have consistent collation
ALTER TABLE SavedPlaylists
    MODIFY COLUMN guildId VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    MODIFY COLUMN userId VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    MODIFY COLUMN name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    MODIFY COLUMN url TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    MODIFY COLUMN platform VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'other';
