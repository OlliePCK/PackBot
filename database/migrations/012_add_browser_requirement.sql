-- Migration: Add browser requirement tracking for page monitors
-- Tracks monitors that require Puppeteer headless browser (e.g., Queue-it protected sites)

-- Add flag to indicate this monitor requires browser-based fetching
ALTER TABLE PageMonitors
ADD COLUMN requiresBrowser TINYINT(1) DEFAULT 0 AFTER alertOnAnyChange;

-- Add reason for browser requirement (e.g., 'queue-it-detected')
ALTER TABLE PageMonitors
ADD COLUMN lastBrowserReason VARCHAR(100) NULL AFTER requiresBrowser;

-- Index for efficient querying of browser-required monitors
CREATE INDEX idx_pagemonitors_browser ON PageMonitors(requiresBrowser);
