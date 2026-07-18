-- Web dashboard sessions, persisted so logins survive bot restarts (they
-- previously lived in memory only and died on every deploy).
CREATE TABLE IF NOT EXISTS Sessions (
    sessionId CHAR(64) NOT NULL PRIMARY KEY,
    userId VARCHAR(32) NOT NULL,
    data LONGTEXT NOT NULL,
    expiresAt DATETIME NOT NULL,
    KEY idx_sessions_expires (expiresAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
