package storage

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// ErrAflAnnouncementClaimLost means a caller tried to complete or release a
// delivery it no longer owns. Claims are leased so a crashed process cannot
// leave an announcement permanently stuck.
var ErrAflAnnouncementClaimLost = errors.New("storage: AFL announcement claim no longer held")

// AflAnnouncementKey is the durable identity of one guild announcement.
// KickoffUnix is included because the upstream fixture can retain its game ID
// when the scheduled bounce time changes.
type AflAnnouncementKey struct {
	GuildID     string
	Kind        string
	GameID      string
	KickoffUnix int64
}

// AflAnnouncementClaim proves temporary ownership of an unsent delivery.
// Call CompleteAflAnnouncement after Discord accepts the message, or
// ReleaseAflAnnouncement when the send fails.
type AflAnnouncementClaim struct {
	Key   AflAnnouncementKey
	Token string
}

// ClaimAflAnnouncement atomically claims an unsent announcement. It returns
// claimed=false when another worker holds a live claim or the announcement
// was already sent. Claims older than two minutes may be recovered after a
// process crash.
func (s *Store) ClaimAflAnnouncement(ctx context.Context, key AflAnnouncementKey) (AflAnnouncementClaim, bool, error) {
	if err := validateAflAnnouncementKey(key); err != nil {
		return AflAnnouncementClaim{}, false, err
	}
	token, err := aflClaimToken()
	if err != nil {
		return AflAnnouncementClaim{}, false, err
	}

	// RowsAffected is 1 for an insert, 2 for a reclaimed row, and 0 when the
	// conditional duplicate-key update is a no-op. Assignment order matters:
	// claimedAt is updated last so every condition sees the previous lease.
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO AflAnnouncementDeliveries
		    (guildId, announcementKind, gameId, kickoffUnix, claimToken, claimedAt, attemptCount)
		 VALUES (?, ?, ?, ?, ?, NOW(), 1)
		 ON DUPLICATE KEY UPDATE
		    attemptCount = IF(
		        sentAt IS NULL AND (claimedAt IS NULL OR claimedAt <= DATE_SUB(NOW(), INTERVAL 2 MINUTE)),
		        attemptCount + 1, attemptCount),
		    lastError = IF(
		        sentAt IS NULL AND (claimedAt IS NULL OR claimedAt <= DATE_SUB(NOW(), INTERVAL 2 MINUTE)),
		        NULL, lastError),
		    claimToken = IF(
		        sentAt IS NULL AND (claimedAt IS NULL OR claimedAt <= DATE_SUB(NOW(), INTERVAL 2 MINUTE)),
		        VALUES(claimToken), claimToken),
		    claimedAt = IF(
		        sentAt IS NULL AND (claimedAt IS NULL OR claimedAt <= DATE_SUB(NOW(), INTERVAL 2 MINUTE)),
		        NOW(), claimedAt)`,
		key.GuildID, key.Kind, key.GameID, key.KickoffUnix, token)
	if err != nil {
		return AflAnnouncementClaim{}, false, fmt.Errorf("storage: claim AFL announcement: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return AflAnnouncementClaim{}, false, fmt.Errorf("storage: claim AFL announcement rows affected: %w", err)
	}
	if n == 0 {
		return AflAnnouncementClaim{}, false, nil
	}
	return AflAnnouncementClaim{Key: key, Token: token}, true, nil
}

// CompleteAflAnnouncement records that Discord accepted a claimed message.
func (s *Store) CompleteAflAnnouncement(ctx context.Context, claim AflAnnouncementClaim) error {
	if err := validateAflAnnouncementClaim(claim); err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE AflAnnouncementDeliveries
		    SET sentAt = NOW(), claimToken = NULL, claimedAt = NULL, lastError = NULL
		  WHERE guildId = ? AND announcementKind = ? AND gameId = ? AND kickoffUnix = ?
		    AND sentAt IS NULL AND claimToken = ?`,
		claim.Key.GuildID, claim.Key.Kind, claim.Key.GameID, claim.Key.KickoffUnix, claim.Token)
	if err != nil {
		return fmt.Errorf("storage: complete AFL announcement: %w", err)
	}
	return requireAflClaimUpdate(res.RowsAffected())
}

// ReleaseAflAnnouncement makes a failed delivery immediately retryable and
// retains a bounded error summary for operational diagnosis.
func (s *Store) ReleaseAflAnnouncement(ctx context.Context, claim AflAnnouncementClaim, cause error) error {
	if err := validateAflAnnouncementClaim(claim); err != nil {
		return err
	}
	var detail any
	if cause != nil {
		detail = truncateRunes(cause.Error(), 512)
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE AflAnnouncementDeliveries
		    SET claimToken = NULL, claimedAt = NULL, lastError = ?
		  WHERE guildId = ? AND announcementKind = ? AND gameId = ? AND kickoffUnix = ?
		    AND sentAt IS NULL AND claimToken = ?`,
		detail, claim.Key.GuildID, claim.Key.Kind, claim.Key.GameID, claim.Key.KickoffUnix, claim.Token)
	if err != nil {
		return fmt.Errorf("storage: release AFL announcement: %w", err)
	}
	return requireAflClaimUpdate(res.RowsAffected())
}

func validateAflAnnouncementKey(key AflAnnouncementKey) error {
	switch {
	case strings.TrimSpace(key.GuildID) == "":
		return errors.New("storage: AFL announcement guild ID is required")
	case len(key.GuildID) > 32:
		return errors.New("storage: AFL announcement guild ID is too long")
	case strings.TrimSpace(key.Kind) == "":
		return errors.New("storage: AFL announcement kind is required")
	case len(key.Kind) > 32:
		return errors.New("storage: AFL announcement kind is too long")
	case strings.TrimSpace(key.GameID) == "":
		return errors.New("storage: AFL announcement game ID is required")
	case len(key.GameID) > 64:
		return errors.New("storage: AFL announcement game ID is too long")
	case key.KickoffUnix <= 0:
		return errors.New("storage: AFL announcement kickoff is required")
	default:
		return nil
	}
}

func validateAflAnnouncementClaim(claim AflAnnouncementClaim) error {
	if err := validateAflAnnouncementKey(claim.Key); err != nil {
		return err
	}
	if len(claim.Token) != 32 {
		return errors.New("storage: invalid AFL announcement claim token")
	}
	return nil
}

func aflClaimToken() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("storage: generate AFL announcement claim token: %w", err)
	}
	return hex.EncodeToString(raw[:]), nil
}

func requireAflClaimUpdate(n int64, err error) error {
	if err != nil {
		return fmt.Errorf("storage: AFL announcement rows affected: %w", err)
	}
	if n != 1 {
		return ErrAflAnnouncementClaimLost
	}
	return nil
}

func truncateRunes(value string, maxRunes int) string {
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes])
}
