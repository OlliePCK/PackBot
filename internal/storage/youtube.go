package storage

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// WatchedChannel is one row of the Youtube watch-list table.
type WatchedChannel struct {
	Handle           string
	ChannelID        string
	GuildID          string
	LastCheckedVideo *string
	Initialized      bool
	CreatedAt        time.Time
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
		`SELECT handle, channelId, guildId, lastCheckedVideo, COALESCE(initialized, 0), createdAt
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
		`SELECT y.handle, y.channelId, y.guildId, y.lastCheckedVideo, COALESCE(y.initialized, 0), y.createdAt,
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
		dest := []any{&w.Handle, &w.ChannelID, &w.GuildID, &w.LastCheckedVideo, &initialized, &w.CreatedAt}
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

// ErrYouTubeNotificationClaimLost means a delivery claim was completed or
// released after its lease was lost.
var ErrYouTubeNotificationClaimLost = errors.New("storage: youtube notification claim no longer held")

// YouTubeNotificationKey is the durable identity of one Discord delivery.
// The Discord target is part of the key so duplicate watch-list rows cannot
// post the same video twice to the same channel.
type YouTubeNotificationKey struct {
	GuildID          string
	NotifyChannelID  string
	YouTubeChannelID string
	VideoID          string
}

type YouTubeNotificationClaim struct {
	Key   YouTubeNotificationKey
	Token string
}

// ClaimYouTubeNotification claims an unsent delivery. A claim left behind by
// a crashed process may be recovered after fifteen minutes.
func (s *Store) ClaimYouTubeNotification(ctx context.Context, key YouTubeNotificationKey,
	publishedAt time.Time) (YouTubeNotificationClaim, bool, error) {
	if err := validateYouTubeNotificationKey(key); err != nil {
		return YouTubeNotificationClaim{}, false, err
	}
	token, err := youtubeClaimToken()
	if err != nil {
		return YouTubeNotificationClaim{}, false, err
	}
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO YoutubeNotificationDeliveries
		    (guildId, notifyChannelId, youtubeChannelId, videoId, publishedAt,
		     claimToken, claimedAt, attemptCount)
		 VALUES (?, ?, ?, ?, ?, ?, NOW(), 1)
		 ON DUPLICATE KEY UPDATE
		    attemptCount = IF(
		        sentAt IS NULL AND skippedAt IS NULL
		        AND (claimedAt IS NULL OR claimedAt <= DATE_SUB(NOW(), INTERVAL 15 MINUTE)),
		        attemptCount + 1, attemptCount),
		    lastError = IF(
		        sentAt IS NULL AND skippedAt IS NULL
		        AND (claimedAt IS NULL OR claimedAt <= DATE_SUB(NOW(), INTERVAL 15 MINUTE)),
		        NULL, lastError),
		    claimToken = IF(
		        sentAt IS NULL AND skippedAt IS NULL
		        AND (claimedAt IS NULL OR claimedAt <= DATE_SUB(NOW(), INTERVAL 15 MINUTE)),
		        VALUES(claimToken), claimToken),
		    claimedAt = IF(
		        sentAt IS NULL AND skippedAt IS NULL
		        AND (claimedAt IS NULL OR claimedAt <= DATE_SUB(NOW(), INTERVAL 15 MINUTE)),
		        NOW(), claimedAt)`,
		key.GuildID, key.NotifyChannelID, key.YouTubeChannelID, key.VideoID, publishedAt, token)
	if err != nil {
		return YouTubeNotificationClaim{}, false, fmt.Errorf("storage: claim youtube notification: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return YouTubeNotificationClaim{}, false, fmt.Errorf("storage: youtube claim rows affected: %w", err)
	}
	if n == 0 {
		return YouTubeNotificationClaim{}, false, nil
	}
	return YouTubeNotificationClaim{Key: key, Token: token}, true, nil
}

func (s *Store) CompleteYouTubeNotification(ctx context.Context, claim YouTubeNotificationClaim,
	messageID string) error {
	if err := validateYouTubeNotificationClaim(claim); err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE YoutubeNotificationDeliveries
		    SET sentAt = NOW(), discordMessageId = ?, claimToken = NULL,
		        claimedAt = NULL, lastError = NULL
		  WHERE notifyChannelId = ? AND youtubeChannelId = ? AND videoId = ?
		    AND sentAt IS NULL AND skippedAt IS NULL AND claimToken = ?`,
		messageID, claim.Key.NotifyChannelID, claim.Key.YouTubeChannelID,
		claim.Key.VideoID, claim.Token)
	if err != nil {
		return fmt.Errorf("storage: complete youtube notification: %w", err)
	}
	return requireYouTubeClaimUpdate(res.RowsAffected())
}

func (s *Store) ReleaseYouTubeNotification(ctx context.Context, claim YouTubeNotificationClaim,
	cause error) error {
	if err := validateYouTubeNotificationClaim(claim); err != nil {
		return err
	}
	var detail any
	if cause != nil {
		detail = truncateRunes(cause.Error(), 512)
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE YoutubeNotificationDeliveries
		    SET claimToken = NULL, claimedAt = NULL, lastError = ?
		  WHERE notifyChannelId = ? AND youtubeChannelId = ? AND videoId = ?
		    AND sentAt IS NULL AND skippedAt IS NULL AND claimToken = ?`,
		detail, claim.Key.NotifyChannelID, claim.Key.YouTubeChannelID,
		claim.Key.VideoID, claim.Token)
	if err != nil {
		return fmt.Errorf("storage: release youtube notification: %w", err)
	}
	return requireYouTubeClaimUpdate(res.RowsAffected())
}

// SkipYouTubeNotification records an ineligible historical video so it never
// becomes a notification after a restart or metadata change.
func (s *Store) SkipYouTubeNotification(ctx context.Context, key YouTubeNotificationKey,
	publishedAt time.Time, reason string) error {
	if err := validateYouTubeNotificationKey(key); err != nil {
		return err
	}
	if strings.TrimSpace(reason) == "" || len(reason) > 64 {
		return errors.New("storage: invalid youtube skip reason")
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO YoutubeNotificationDeliveries
		    (guildId, notifyChannelId, youtubeChannelId, videoId, publishedAt,
		     skippedAt, skipReason)
		 VALUES (?, ?, ?, ?, ?, NOW(), ?)
		 ON DUPLICATE KEY UPDATE
		    skipReason = IF(sentAt IS NULL AND skippedAt IS NOT NULL,
		                    VALUES(skipReason), skipReason)`,
		key.GuildID, key.NotifyChannelID, key.YouTubeChannelID, key.VideoID,
		publishedAt, reason)
	if err != nil {
		return fmt.Errorf("storage: skip youtube notification: %w", err)
	}
	return nil
}

func validateYouTubeNotificationKey(key YouTubeNotificationKey) error {
	switch {
	case strings.TrimSpace(key.GuildID) == "" || len(key.GuildID) > 32:
		return errors.New("storage: invalid youtube notification guild ID")
	case strings.TrimSpace(key.NotifyChannelID) == "" || len(key.NotifyChannelID) > 32:
		return errors.New("storage: invalid youtube notification target channel ID")
	case strings.TrimSpace(key.YouTubeChannelID) == "" || len(key.YouTubeChannelID) > 64:
		return errors.New("storage: invalid youtube channel ID")
	case strings.TrimSpace(key.VideoID) == "" || len(key.VideoID) > 64:
		return errors.New("storage: invalid youtube video ID")
	default:
		return nil
	}
}

func validateYouTubeNotificationClaim(claim YouTubeNotificationClaim) error {
	if err := validateYouTubeNotificationKey(claim.Key); err != nil {
		return err
	}
	if len(claim.Token) != 32 {
		return errors.New("storage: invalid youtube notification claim token")
	}
	return nil
}

func youtubeClaimToken() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("storage: generate youtube notification claim token: %w", err)
	}
	return hex.EncodeToString(raw[:]), nil
}

func requireYouTubeClaimUpdate(n int64, err error) error {
	if err != nil {
		return fmt.Errorf("storage: youtube claim rows affected: %w", err)
	}
	if n != 1 {
		return ErrYouTubeNotificationClaimLost
	}
	return nil
}
