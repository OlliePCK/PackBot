-- Migration: Create IMAX Big League credentials table
-- Stores encrypted Big League member credentials for auto-checkout

CREATE TABLE IF NOT EXISTS ImaxCredentials (
    id INT AUTO_INCREMENT PRIMARY KEY,
    odUserId VARCHAR(32) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL,
    -- Password is encrypted using AES with IMAX_ENCRYPTION_KEY env var
    encryptedPassword TEXT NOT NULL,
    memberNumber VARCHAR(50) NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    lastUsedAt DATETIME NULL,
    INDEX idx_imax_creds_user (odUserId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Store checkout history for debugging/audit
CREATE TABLE IF NOT EXISTS ImaxCheckoutLog (
    id INT AUTO_INCREMENT PRIMARY KEY,
    odUserId VARCHAR(32) NOT NULL,
    sessionId VARCHAR(50) NOT NULL,
    movieTitle VARCHAR(200) NULL,
    sessionDate DATE NULL,
    sessionTime VARCHAR(20) NULL,
    numSeats INT NOT NULL,
    selectedSeats JSON NULL,
    checkoutUrl TEXT NULL,
    status ENUM('prefilled', 'completed', 'failed', 'cancelled') DEFAULT 'prefilled',
    errorMessage TEXT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_checkout_user (odUserId),
    INDEX idx_checkout_session (sessionId),
    INDEX idx_checkout_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
