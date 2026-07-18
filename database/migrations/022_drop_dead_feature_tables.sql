-- The Go rewrite dropped starboard, quotes, Deepgram voice commands, and the
-- page monitor; production removed their tables by hand on 2026-07-17 (backed
-- up to grid appdata first). This aligns fresh installs with that reality.
DROP TABLE IF EXISTS Quotes;
DROP TABLE IF EXISTS Starboard;
DROP TABLE IF EXISTS VoiceWhitelist;
DROP TABLE IF EXISTS PageMonitors;
