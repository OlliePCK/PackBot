-- Migration: Add enhanced monitor columns for site-specific parsing
-- This migration adds support for different monitor types (Shopify, Ticketmaster, etc.)
-- and structured data storage for smart change detection

-- Add monitor type column
ALTER TABLE PageMonitors 
ADD COLUMN monitorType VARCHAR(50) DEFAULT 'auto' AFTER roleToMention;

-- Add detected type (what was auto-detected)
ALTER TABLE PageMonitors 
ADD COLUMN detectedType VARCHAR(50) NULL AFTER monitorType;

-- Add alert settings JSON (configurable alert preferences)
ALTER TABLE PageMonitors 
ADD COLUMN alertSettings JSON NULL AFTER detectedType;

-- Add flag for alerting on any change (fallback mode)
ALTER TABLE PageMonitors 
ADD COLUMN alertOnAnyChange TINYINT(1) DEFAULT 0 AFTER alertSettings;

-- Add last parsed data JSON (for smart comparison)
ALTER TABLE PageMonitors 
ADD COLUMN lastParsedData LONGTEXT NULL AFTER lastHash;

-- Add index on monitor type for filtering
CREATE INDEX idx_pagemonitors_type ON PageMonitors(monitorType);

-- Update existing monitors to use 'auto' type
UPDATE PageMonitors SET monitorType = 'auto' WHERE monitorType IS NULL;
