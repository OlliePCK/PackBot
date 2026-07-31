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

// MinecraftCount is one leaderboard row: a name and a tally.
type MinecraftCount struct {
	Name  string
	Count int
}

// DeathRecord is one death, with coordinates when they could be read.
type DeathRecord struct {
	MCUsername string
	Cause      string
	X, Y, Z    *int
	Dimension  string
	DiedAt     time.Time
}

// RecordMinecraftDeath appends one death. loc may be nil when the position
// could not be read — the death still counts, it just cannot be plotted.
func (s *Store) RecordMinecraftDeath(ctx context.Context, mcUsername, cause string, x, y, z *int, dimension string) error {
	if len(cause) > 255 {
		cause = cause[:255]
	}
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO MinecraftDeaths (mcUsername, cause, x, y, z, dimension)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		mcUsername, cause, x, y, z, nullIfEmpty(dimension)); err != nil {
		return fmt.Errorf("storage: record minecraft death: %w", err)
	}
	return nil
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// RecentMinecraftDeaths returns deaths that have coordinates, newest first —
// the plottable set.
func (s *Store) RecentMinecraftDeaths(ctx context.Context, limit int) ([]DeathRecord, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT mcUsername, cause, x, y, z, COALESCE(dimension, ''), diedAt
		   FROM MinecraftDeaths
		  WHERE x IS NOT NULL
		  ORDER BY diedAt DESC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("storage: recent minecraft deaths: %w", err)
	}
	defer rows.Close()

	var out []DeathRecord
	for rows.Next() {
		var d DeathRecord
		if err := rows.Scan(&d.MCUsername, &d.Cause, &d.X, &d.Y, &d.Z, &d.Dimension, &d.DiedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// TopMinecraftDeaths ranks players by how often they have died.
func (s *Store) TopMinecraftDeaths(ctx context.Context, limit int) ([]MinecraftCount, error) {
	return s.minecraftCounts(ctx,
		`SELECT mcUsername, COUNT(*) AS n FROM MinecraftDeaths
		  GROUP BY mcUsername ORDER BY n DESC LIMIT ?`, limit)
}

// TopMinecraftDeathCauses ranks the ways people die, with the leading verb
// phrase kept but any trailing detail ("by Enderman") dropped so that
// "was slain by Enderman" and "was slain by Zombie" group together.
func (s *Store) TopMinecraftDeathCauses(ctx context.Context, limit int) ([]MinecraftCount, error) {
	return s.minecraftCounts(ctx,
		`SELECT SUBSTRING_INDEX(cause, ' by ', 1) AS c, COUNT(*) AS n
		   FROM MinecraftDeaths GROUP BY c ORDER BY n DESC LIMIT ?`, limit)
}

// RecordMinecraftAdvancement stores an earned advancement and reports whether
// this player was the first on the server to earn it.
//
// The check runs before the insert, so the winner is whoever's row lands
// first; at a friend-group's event rate the race is not worth locking for.
func (s *Store) RecordMinecraftAdvancement(ctx context.Context, mcUsername, advancement string) (first bool, err error) {
	if len(advancement) > 128 {
		advancement = advancement[:128]
	}

	var existing int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM MinecraftAdvancements WHERE advancement = ?`,
		advancement).Scan(&existing); err != nil {
		return false, fmt.Errorf("storage: check advancement: %w", err)
	}

	res, err := s.db.ExecContext(ctx,
		`INSERT IGNORE INTO MinecraftAdvancements (mcUsername, advancement) VALUES (?, ?)`,
		mcUsername, advancement)
	if err != nil {
		return false, fmt.Errorf("storage: record advancement: %w", err)
	}
	// INSERT IGNORE affects no rows when the player already had it, in which
	// case this is a replay rather than a new achievement.
	n, _ := res.RowsAffected()
	return existing == 0 && n > 0, nil
}

// TopMinecraftAdvancements ranks players by how many advancements they hold.
func (s *Store) TopMinecraftAdvancements(ctx context.Context, limit int) ([]MinecraftCount, error) {
	return s.minecraftCounts(ctx,
		`SELECT mcUsername, COUNT(*) AS n FROM MinecraftAdvancements
		  GROUP BY mcUsername ORDER BY n DESC LIMIT ?`, limit)
}

// MinecraftFirsts counts how many advancements each player earned before
// anyone else — the actual race scoreboard.
func (s *Store) MinecraftFirsts(ctx context.Context, limit int) ([]MinecraftCount, error) {
	return s.minecraftCounts(ctx,
		`SELECT mcUsername, COUNT(*) AS n FROM MinecraftAdvancements a
		  WHERE earnedAt = (SELECT MIN(b.earnedAt) FROM MinecraftAdvancements b
		                     WHERE b.advancement = a.advancement)
		  GROUP BY mcUsername ORDER BY n DESC LIMIT ?`, limit)
}

func (s *Store) minecraftCounts(ctx context.Context, query string, args ...any) ([]MinecraftCount, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("storage: minecraft counts: %w", err)
	}
	defer rows.Close()

	var out []MinecraftCount
	for rows.Next() {
		var c MinecraftCount
		if err := rows.Scan(&c.Name, &c.Count); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
