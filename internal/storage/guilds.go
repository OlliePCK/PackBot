package storage

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"
)

// GuildProfile is the per-guild settings row (Guilds table). Nullable ID
// columns are pointers: nil means "not set".
type GuildProfile struct {
	GuildID             string
	LiveRoleID          *string
	LiveChannelID       *string
	GeneralChannelID    *string
	YouTubeChannelID    *string
	TwentyFourSevenMode bool
}

const guildCacheTTL = 5 * time.Minute

type guildCache struct {
	mu      sync.Mutex
	entries map[string]guildCacheEntry
}

type guildCacheEntry struct {
	profile *GuildProfile
	at      time.Time
}

func newGuildCache() guildCache {
	return guildCache{entries: make(map[string]guildCacheEntry)}
}

// GuildProfile returns the guild's settings, creating the row on first access
// (parity with Node's ensureGuildRow) and caching it for 5 minutes.
func (s *Store) GuildProfile(ctx context.Context, guildID string) (*GuildProfile, error) {
	s.guildCache.mu.Lock()
	if e, ok := s.guildCache.entries[guildID]; ok && time.Since(e.at) < guildCacheTTL {
		s.guildCache.mu.Unlock()
		return e.profile, nil
	}
	s.guildCache.mu.Unlock()

	if _, err := s.db.ExecContext(ctx,
		`INSERT IGNORE INTO Guilds (guildId) VALUES (?)`, guildID); err != nil {
		return nil, fmt.Errorf("storage: ensure guild row: %w", err)
	}

	p := &GuildProfile{GuildID: guildID}
	var twentyFourSeven sql.NullBool
	err := s.db.QueryRowContext(ctx,
		`SELECT liveRoleID, liveChannelID, generalChannelID, youtubeChannelID, twentyFourSevenMode
		   FROM Guilds WHERE guildId = ? LIMIT 1`, guildID).
		Scan(&p.LiveRoleID, &p.LiveChannelID, &p.GeneralChannelID, &p.YouTubeChannelID, &twentyFourSeven)
	if err != nil {
		return nil, fmt.Errorf("storage: load guild profile: %w", err)
	}
	p.TwentyFourSevenMode = twentyFourSeven.Valid && twentyFourSeven.Bool

	s.guildCache.mu.Lock()
	s.guildCache.entries[guildID] = guildCacheEntry{profile: p, at: time.Now()}
	s.guildCache.mu.Unlock()
	return p, nil
}

// InvalidateGuild drops a guild from the settings cache (call after updates).
func (s *Store) InvalidateGuild(guildID string) {
	s.guildCache.mu.Lock()
	delete(s.guildCache.entries, guildID)
	s.guildCache.mu.Unlock()
}

// guildSettingColumns whitelists the columns UpdateGuildSetting may touch —
// column names are interpolated into SQL, so they must never come from input.
var guildSettingColumns = map[string]bool{
	"liveRoleID":          true,
	"liveChannelID":       true,
	"generalChannelID":    true,
	"youtubeChannelID":    true,
	"twentyFourSevenMode": true,
}

// UpdateGuildSetting sets one whitelisted settings column and invalidates the
// cache. value may be a string ID, an int, or nil to clear.
func (s *Store) UpdateGuildSetting(ctx context.Context, guildID, column string, value any) error {
	if !guildSettingColumns[column] {
		return fmt.Errorf("storage: refusing to update non-whitelisted column %q", column)
	}
	_, err := s.db.ExecContext(ctx,
		fmt.Sprintf("UPDATE Guilds SET %s = ? WHERE guildId = ?", column), value, guildID)
	if err != nil {
		return fmt.Errorf("storage: update guild setting %s: %w", column, err)
	}
	s.InvalidateGuild(guildID)
	return nil
}
