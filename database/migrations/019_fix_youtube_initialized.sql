-- Migration 019: Fix YouTube initialized flag stuck at 0 from seeding bug
-- The opus rewrite (Dec 2025) set initialized=0 instead of 1 when seeding,
-- causing subscriptions to never transition to the notification state.

UPDATE Youtube SET initialized = 1 WHERE initialized = 0 AND lastCheckedVideo IS NOT NULL;
