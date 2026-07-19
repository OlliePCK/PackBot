package storage

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// MediaLiveCard is the durable Discord delivery state for one Jellyfin
// channel lifecycle. Pending rows have deliberately unknown Discord state
// and therefore fail closed rather than risking a duplicate send.
type MediaLiveCard struct {
	GuildID           string
	JellyfinChannelID string
	DiscordChannelID  string
	DiscordMessageID  string
	Status            string
	FirstSeenAt       time.Time
	LastSeenAt        time.Time
}

const (
	MediaCardPending = "pending"
	MediaCardActive  = "active"
)

// MediaLiveCards returns all recorded Live TV deliveries for the one
// configured media guild.
func (s *Store) MediaLiveCards(ctx context.Context, guildID string) ([]MediaLiveCard, error) {
	if err := validateSnowflake("media guild ID", guildID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT guildId, jellyfinChannelId, discordChannelId,
		        COALESCE(discordMessageId, ''), status, firstSeenAt, lastSeenAt
		   FROM MediaLiveCards
		  WHERE guildId = ?
		  ORDER BY jellyfinChannelId`, strings.TrimSpace(guildID))
	if err != nil {
		return nil, fmt.Errorf("storage: list media live cards: %w", err)
	}
	defer rows.Close()

	var cards []MediaLiveCard
	for rows.Next() {
		var card MediaLiveCard
		if err := rows.Scan(
			&card.GuildID,
			&card.JellyfinChannelID,
			&card.DiscordChannelID,
			&card.DiscordMessageID,
			&card.Status,
			&card.FirstSeenAt,
			&card.LastSeenAt,
		); err != nil {
			return nil, fmt.Errorf("storage: scan media live card: %w", err)
		}
		cards = append(cards, card)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("storage: iterate media live cards: %w", err)
	}
	return cards, nil
}

// ClaimMediaLiveCard atomically reserves a channel lifecycle before Discord
// is called. Existing active or pending rows return claimed=false.
func (s *Store) ClaimMediaLiveCard(
	ctx context.Context,
	guildID, jellyfinChannelID, discordChannelID string,
	firstSeenAt time.Time,
) (bool, error) {
	if err := validateMediaCardIdentity(guildID, jellyfinChannelID, discordChannelID); err != nil {
		return false, err
	}
	if firstSeenAt.IsZero() {
		return false, errors.New("storage: media first-seen time is required")
	}
	res, err := s.db.ExecContext(ctx,
		`INSERT IGNORE INTO MediaLiveCards
		    (guildId, jellyfinChannelId, discordChannelId, status, firstSeenAt, lastSeenAt)
		 VALUES (?, ?, ?, 'pending', ?, ?)`,
		strings.TrimSpace(guildID),
		strings.TrimSpace(jellyfinChannelID),
		strings.TrimSpace(discordChannelID),
		firstSeenAt,
		firstSeenAt,
	)
	if err != nil {
		return false, fmt.Errorf("storage: claim media live card: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("storage: claim media live card rows affected: %w", err)
	}
	return n == 1, nil
}

// ReleaseMediaLiveCard removes a pending claim after Discord has returned a
// definite rejection. The destination and pending/no-message predicates make
// it impossible for this cleanup to delete an activated delivery.
func (s *Store) ReleaseMediaLiveCard(
	ctx context.Context,
	guildID, jellyfinChannelID, discordChannelID string,
) error {
	if err := validateMediaCardIdentity(guildID, jellyfinChannelID, discordChannelID); err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM MediaLiveCards
		  WHERE guildId = ? AND jellyfinChannelId = ? AND discordChannelId = ?
		    AND status = 'pending' AND discordMessageId IS NULL`,
		strings.TrimSpace(guildID),
		strings.TrimSpace(jellyfinChannelID),
		strings.TrimSpace(discordChannelID),
	)
	if err != nil {
		return fmt.Errorf("storage: release media live card: %w", err)
	}
	n, rowsErr := res.RowsAffected()
	return requireSingleMediaUpdate(n, "release", rowsErr)
}

// ActivateMediaLiveCard records the Discord message ID after a claimed send
// succeeds. Only a pending row may be activated.
func (s *Store) ActivateMediaLiveCard(
	ctx context.Context,
	guildID, jellyfinChannelID, discordChannelID, discordMessageID string,
	lastSeenAt time.Time,
) error {
	if err := validateMediaCardIdentity(guildID, jellyfinChannelID, discordChannelID); err != nil {
		return err
	}
	if err := validateSnowflake("media Discord message ID", discordMessageID); err != nil {
		return err
	}
	if lastSeenAt.IsZero() {
		return errors.New("storage: media last-seen time is required")
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE MediaLiveCards
		    SET discordMessageId = ?, status = 'active', lastSeenAt = ?
		  WHERE guildId = ? AND jellyfinChannelId = ? AND discordChannelId = ?
		    AND status = 'pending' AND discordMessageId IS NULL`,
		strings.TrimSpace(discordMessageID),
		lastSeenAt,
		strings.TrimSpace(guildID),
		strings.TrimSpace(jellyfinChannelID),
		strings.TrimSpace(discordChannelID),
	)
	if err != nil {
		return fmt.Errorf("storage: activate media live card: %w", err)
	}
	n, rowsErr := res.RowsAffected()
	return requireSingleMediaUpdate(n, "activate", rowsErr)
}

// TouchMediaLiveCard records a successful reconciliation/edit for an active
// card without persisting any viewer or programme data.
func (s *Store) TouchMediaLiveCard(
	ctx context.Context,
	guildID, jellyfinChannelID, discordMessageID string,
	lastSeenAt time.Time,
) error {
	if err := validateSnowflake("media guild ID", guildID); err != nil {
		return err
	}
	if err := validateJellyfinChannelID(jellyfinChannelID); err != nil {
		return err
	}
	if err := validateSnowflake("media Discord message ID", discordMessageID); err != nil {
		return err
	}
	if lastSeenAt.IsZero() {
		return errors.New("storage: media last-seen time is required")
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE MediaLiveCards
		    SET lastSeenAt = ?
		  WHERE guildId = ? AND jellyfinChannelId = ?
		    AND discordMessageId = ? AND status = 'active'`,
		lastSeenAt,
		strings.TrimSpace(guildID),
		strings.TrimSpace(jellyfinChannelID),
		strings.TrimSpace(discordMessageID),
	)
	if err != nil {
		return fmt.Errorf("storage: touch media live card: %w", err)
	}
	n, rowsErr := res.RowsAffected()
	return requireSingleMediaUpdate(n, "touch", rowsErr)
}

// DeleteMediaLiveCard removes a completed lifecycle. Callers delete the
// Discord message first so a database failure cannot leave an untracked card.
func (s *Store) DeleteMediaLiveCard(ctx context.Context, guildID, jellyfinChannelID string) error {
	if err := validateSnowflake("media guild ID", guildID); err != nil {
		return err
	}
	if err := validateJellyfinChannelID(jellyfinChannelID); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM MediaLiveCards WHERE guildId = ? AND jellyfinChannelId = ?`,
		strings.TrimSpace(guildID), strings.TrimSpace(jellyfinChannelID)); err != nil {
		return fmt.Errorf("storage: delete media live card: %w", err)
	}
	return nil
}

func validateMediaCardIdentity(guildID, jellyfinChannelID, discordChannelID string) error {
	if err := validateSnowflake("media guild ID", guildID); err != nil {
		return err
	}
	if err := validateJellyfinChannelID(jellyfinChannelID); err != nil {
		return err
	}
	return validateSnowflake("media Discord channel ID", discordChannelID)
}

func validateSnowflake(label, value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return fmt.Errorf("storage: %s is required", label)
	}
	if len(value) > 32 {
		return fmt.Errorf("storage: %s is too long", label)
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return fmt.Errorf("storage: %s must contain only digits", label)
		}
	}
	return nil
}

func validateJellyfinChannelID(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return errors.New("storage: Jellyfin channel ID is required")
	}
	if len(value) > 64 {
		return errors.New("storage: Jellyfin channel ID is too long")
	}
	for _, r := range value {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') && r != '-' {
			return errors.New("storage: Jellyfin channel ID contains invalid characters")
		}
	}
	return nil
}

func requireSingleMediaUpdate(n int64, action string, err error) error {
	if err != nil {
		return fmt.Errorf("storage: %s media live card rows affected: %w", action, err)
	}
	if n != 1 {
		return fmt.Errorf("storage: %s media live card: state changed concurrently", action)
	}
	return nil
}
