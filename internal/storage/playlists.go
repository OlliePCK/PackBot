package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// SavedPlaylist is one row of the SavedPlaylists table.
type SavedPlaylist struct {
	Name      string
	URL       string
	Platform  string
	CreatedAt time.Time
}

// MaxSavedPlaylists is the per-user, per-guild cap (parity with Node).
const MaxSavedPlaylists = 25

// ErrPlaylistLimit is returned by SavePlaylist when the user is at the cap.
var ErrPlaylistLimit = errors.New("storage: saved playlist limit reached")

// SavePlaylist inserts or updates a saved playlist, enforcing the cap.
func (s *Store) SavePlaylist(ctx context.Context, guildID, userID, name, url, platform string) error {
	var count int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM SavedPlaylists WHERE guildId = ? AND userId = ?`,
		guildID, userID).Scan(&count)
	if err != nil {
		return fmt.Errorf("storage: count playlists: %w", err)
	}
	if count >= MaxSavedPlaylists {
		return ErrPlaylistLimit
	}

	_, err = s.db.ExecContext(ctx,
		`INSERT INTO SavedPlaylists (guildId, userId, name, url, platform)
		 VALUES (?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE url = VALUES(url), platform = VALUES(platform)`,
		guildID, userID, name, url, platform)
	if err != nil {
		return fmt.Errorf("storage: save playlist: %w", err)
	}
	return nil
}

// GetPlaylist looks up one saved playlist by name (nil when absent).
func (s *Store) GetPlaylist(ctx context.Context, guildID, userID, name string) (*SavedPlaylist, error) {
	var p SavedPlaylist
	p.Name = name
	err := s.db.QueryRowContext(ctx,
		`SELECT url, platform FROM SavedPlaylists
		  WHERE guildId = ? AND userId = ? AND name = ?`,
		guildID, userID, name).Scan(&p.URL, &p.Platform)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("storage: get playlist: %w", err)
	}
	return &p, nil
}

// ListPlaylists returns a user's saved playlists ordered by name.
func (s *Store) ListPlaylists(ctx context.Context, guildID, userID string) ([]SavedPlaylist, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT name, url, platform, createdAt FROM SavedPlaylists
		  WHERE guildId = ? AND userId = ? ORDER BY name`, guildID, userID)
	if err != nil {
		return nil, fmt.Errorf("storage: list playlists: %w", err)
	}
	defer rows.Close()

	var out []SavedPlaylist
	for rows.Next() {
		var p SavedPlaylist
		if err := rows.Scan(&p.Name, &p.URL, &p.Platform, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// DeletePlaylist removes a saved playlist; reports whether it existed.
func (s *Store) DeletePlaylist(ctx context.Context, guildID, userID, name string) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM SavedPlaylists WHERE guildId = ? AND userId = ? AND name = ?`,
		guildID, userID, name)
	if err != nil {
		return false, fmt.Errorf("storage: delete playlist: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func isNoRows(err error) bool {
	return errors.Is(err, sql.ErrNoRows)
}
