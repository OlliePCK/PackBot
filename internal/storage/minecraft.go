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

// LinkMinecraftAccount records (or re-points) a user's Minecraft username.
//
// The unique index on mcUsername is what stops one person claiming another's
// account, so a duplicate-key error is translated rather than surfaced raw.
func (s *Store) LinkMinecraftAccount(ctx context.Context, guildID, userID, mcUsername string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO MinecraftAccounts (guildId, odUserId, mcUsername)
		 VALUES (?, ?, ?)
		 ON DUPLICATE KEY UPDATE mcUsername = VALUES(mcUsername)`,
		guildID, userID, mcUsername)
	if err != nil {
		if IsDuplicateKey(err) {
			return ErrMinecraftNameTaken
		}
		return fmt.Errorf("storage: link minecraft account: %w", err)
	}
	return nil
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

// SetMinecraftWhitelisted records whether the server currently has this user
// whitelisted, so role reconciliation doesn't re-issue RCON commands that have
// already been applied.
func (s *Store) SetMinecraftWhitelisted(ctx context.Context, guildID, userID string, whitelisted bool) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE MinecraftAccounts SET whitelisted = ? WHERE guildId = ? AND odUserId = ?`,
		whitelisted, guildID, userID)
	if err != nil {
		return fmt.Errorf("storage: set minecraft whitelisted: %w", err)
	}
	return nil
}

// ListMinecraftAccounts returns every link in a guild, newest first.
func (s *Store) ListMinecraftAccounts(ctx context.Context, guildID string) ([]MinecraftAccount, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT guildId, odUserId, mcUsername, whitelisted, linkedAt
		   FROM MinecraftAccounts WHERE guildId = ? ORDER BY linkedAt DESC`, guildID)
	if err != nil {
		return nil, fmt.Errorf("storage: list minecraft accounts: %w", err)
	}
	defer rows.Close()

	var out []MinecraftAccount
	for rows.Next() {
		var a MinecraftAccount
		if err := rows.Scan(&a.GuildID, &a.UserID, &a.MCUsername, &a.Whitelisted, &a.LinkedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
