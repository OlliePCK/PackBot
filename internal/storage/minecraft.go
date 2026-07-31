package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrMinecraftNameTaken means another Discord user in the guild has already
// claimed that Minecraft username.
var ErrMinecraftNameTaken = errors.New("storage: minecraft username already linked to another user")

// MinecraftAccount is one Discord ↔ Minecraft link.
type MinecraftAccount struct {
	GuildID     string
	UserID      string
	MCUsername  string
	Whitelisted bool
	LinkedAt    time.Time
}

// UnlinkMinecraftAccount removes a link, reporting whether one existed.
func (s *Store) UnlinkMinecraftAccount(ctx context.Context, guildID, userID string) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM MinecraftAccounts WHERE guildId = ? AND odUserId = ?`, guildID, userID)
	if err != nil {
		return false, fmt.Errorf("storage: unlink minecraft account: %w", err)
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// MinecraftAccountForUser returns a user's link, or nil when unlinked.
func (s *Store) MinecraftAccountForUser(ctx context.Context, guildID, userID string) (*MinecraftAccount, error) {
	return s.scanMinecraftAccount(ctx,
		`SELECT guildId, odUserId, mcUsername, whitelisted, linkedAt
		   FROM MinecraftAccounts WHERE guildId = ? AND odUserId = ?`, guildID, userID)
}

// MinecraftAccountByUsername resolves a Minecraft username back to its Discord
// owner. The column collation makes this case-insensitive.
func (s *Store) MinecraftAccountByUsername(ctx context.Context, guildID, mcUsername string) (*MinecraftAccount, error) {
	return s.scanMinecraftAccount(ctx,
		`SELECT guildId, odUserId, mcUsername, whitelisted, linkedAt
		   FROM MinecraftAccounts WHERE guildId = ? AND mcUsername = ?`, guildID, mcUsername)
}

func (s *Store) scanMinecraftAccount(ctx context.Context, query string, args ...any) (*MinecraftAccount, error) {
	var a MinecraftAccount
	err := s.db.QueryRowContext(ctx, query, args...).
		Scan(&a.GuildID, &a.UserID, &a.MCUsername, &a.Whitelisted, &a.LinkedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("storage: read minecraft account: %w", err)
	}
	return &a, nil
}


// MinecraftPlaytimeEntry is one leaderboard row, keyed on the in-game name.
type MinecraftPlaytimeEntry struct {
	MCUsername   string
	TotalSeconds int64
	LastSeenAt   time.Time
}

// RecordMinecraftPlaytime accumulates seconds against an in-game username.
func (s *Store) RecordMinecraftPlaytime(ctx context.Context, mcUsername string, seconds int64) error {
	if seconds <= 0 {
		return nil
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO MinecraftPlaytime (mcUsername, totalSeconds)
		 VALUES (?, ?)
		 ON DUPLICATE KEY UPDATE
		   totalSeconds = totalSeconds + VALUES(totalSeconds),
		   lastSeenAt   = CURRENT_TIMESTAMP`,
		mcUsername, seconds)
	if err != nil {
		return fmt.Errorf("storage: record minecraft playtime: %w", err)
	}
	return nil
}

// TopMinecraftPlaytime returns the most-played players, longest first.
func (s *Store) TopMinecraftPlaytime(ctx context.Context, limit int) ([]MinecraftPlaytimeEntry, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT mcUsername, totalSeconds, lastSeenAt
		   FROM MinecraftPlaytime
		  ORDER BY totalSeconds DESC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("storage: minecraft leaderboard: %w", err)
	}
	defer rows.Close()

	var out []MinecraftPlaytimeEntry
	for rows.Next() {
		var e MinecraftPlaytimeEntry
		if err := rows.Scan(&e.MCUsername, &e.TotalSeconds, &e.LastSeenAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ClaimMinecraftAccount records a self-service whitelist claim, returning the
// username this user previously held (empty if none) so the caller can remove
// the stale entry from the server's whitelist.
func (s *Store) ClaimMinecraftAccount(ctx context.Context, guildID, userID, mcUsername string) (previous string, err error) {
	existing, err := s.MinecraftAccountForUser(ctx, guildID, userID)
	if err != nil {
		return "", err
	}
	if existing != nil {
		previous = existing.MCUsername
		if previous == mcUsername {
			previous = "" // unchanged; nothing to clean up
		}
	}

	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO MinecraftAccounts (guildId, odUserId, mcUsername, whitelisted)
		 VALUES (?, ?, ?, 1)
		 ON DUPLICATE KEY UPDATE mcUsername = VALUES(mcUsername), whitelisted = 1`,
		guildID, userID, mcUsername); err != nil {
		if IsDuplicateKey(err) {
			return "", ErrMinecraftNameTaken
		}
		return "", fmt.Errorf("storage: claim minecraft account: %w", err)
	}
	return previous, nil
}
