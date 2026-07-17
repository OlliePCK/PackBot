package storage

import (
	"context"
	"fmt"
	"strings"
)

// WatchedChannel is one row of the Youtube watch-list table.
type WatchedChannel struct {
	Handle           string
	ChannelID        string
	GuildID          string
	LastCheckedVideo *string
	Initialized      bool
	NotifyChannelID  string // joined from Guilds.youtubeChannelID
}

// ErrDuplicateWatch is reported via IsDuplicateKey on double-adds.

// AddWatchedChannel inserts a watch-list row. MySQL error 1062 (duplicate
// unique key channelId+guildId) surfaces to the caller for the "already
// tracked" message.
func (s *Store) AddWatchedChannel(ctx context.Context, handle, channelID, guildID string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO Youtube (handle, channelId, guildId, lastChecked) VALUES (?, ?, ?, NOW())`,
		handle, channelID, guildID)
	if err != nil {
		return fmt.Errorf("storage: add watched channel: %w", err)
	}
	return nil
}

// IsDuplicateKey reports whether err is a MySQL duplicate-key violation.
func IsDuplicateKey(err error) bool {
	return err != nil && strings.Contains(err.Error(), "Error 1062")
}

// RemoveWatchedChannel deletes a watch-list row; reports whether it existed.
func (s *Store) RemoveWatchedChannel(ctx context.Context, handle, guildID string) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM Youtube WHERE handle = ? AND guildId = ?`, handle, guildID)
	if err != nil {
		return false, fmt.Errorf("storage: remove watched channel: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// ListWatchedChannels returns a guild's watch-list.
func (s *Store) ListWatchedChannels(ctx context.Context, guildID string) ([]WatchedChannel, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT handle, channelId, guildId, lastCheckedVideo, initialized
		   FROM Youtube WHERE guildId = ? ORDER BY handle`, guildID)
	if err != nil {
		return nil, fmt.Errorf("storage: list watched channels: %w", err)
	}
	defer rows.Close()
	return scanWatchedChannels(rows, false)
}

// WatchList returns every watch-list row whose guild has a notification
// channel configured (the notifications job's working set).
func (s *Store) WatchList(ctx context.Context) ([]WatchedChannel, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT y.handle, y.channelId, y.guildId, y.lastCheckedVideo, y.initialized,
		        g.youtubeChannelID
		   FROM Youtube y
		   JOIN Guilds g ON g.guildId = y.guildId
		  WHERE g.youtubeChannelID IS NOT NULL`)
	if err != nil {
		return nil, fmt.Errorf("storage: load watch list: %w", err)
	}
	defer rows.Close()
	return scanWatchedChannels(rows, true)
}

// MarkVideoSeen records the latest seen video for one watch-list row and
// flips initialized (used both for seeding and after notifying).
func (s *Store) MarkVideoSeen(ctx context.Context, handle, channelID, guildID, videoID string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO Youtube (handle, channelId, guildId, lastCheckedVideo, initialized, lastChecked)
		 VALUES (?, ?, ?, ?, 1, NOW())
		 ON DUPLICATE KEY UPDATE
		   lastCheckedVideo = VALUES(lastCheckedVideo),
		   initialized      = VALUES(initialized),
		   lastChecked      = NOW()`,
		handle, channelID, guildID, videoID)
	if err != nil {
		return fmt.Errorf("storage: mark video seen: %w", err)
	}
	return nil
}

func scanWatchedChannels(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
}, withNotify bool) ([]WatchedChannel, error) {
	var out []WatchedChannel
	for rows.Next() {
		var w WatchedChannel
		var initialized int
		dest := []any{&w.Handle, &w.ChannelID, &w.GuildID, &w.LastCheckedVideo, &initialized}
		if withNotify {
			dest = append(dest, &w.NotifyChannelID)
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		w.Initialized = initialized != 0
		out = append(out, w)
	}
	return out, rows.Err()
}
