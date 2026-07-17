package storage

import (
	"context"
	"fmt"
)

// ListenerStats is one row of the music-listening leaderboard.
type ListenerStats struct {
	UserID       string
	Username     string
	TotalSeconds int64
	PlayCount    int
	UniqueTracks int
}

// TrackPlays is a track with its play count.
type TrackPlays struct {
	Title     string
	Artist    string
	PlayCount int
}

// ArtistPlays is an artist with their play count.
type ArtistPlays struct {
	Artist    string
	PlayCount int
}

// WrappedStats are a user's (or guild's) aggregate listening totals.
type WrappedStats struct {
	TotalTracks   int
	TotalSeconds  int64
	UniqueTracks  int
	UniqueArtists int
}

// LogListen records a played track into ListeningHistory (Node logged this
// from the playSong event).
func (s *Store) LogListen(ctx context.Context, guildID, userID, username, title, artist, url, thumbnail string, durationSeconds int) error {
	var artistVal, urlVal, thumbVal *string
	if artist != "" {
		artistVal = &artist
	}
	if url != "" {
		urlVal = &url
	}
	if thumbnail != "" {
		thumbVal = &thumbnail
	}
	if len(title) > 255 {
		title = title[:255]
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO ListeningHistory (guildId, odUserId, odUsername, trackTitle, trackArtist, trackUrl, trackThumbnail, durationSeconds)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		guildID, userID, username, title, artistVal, urlVal, thumbVal, durationSeconds)
	if err != nil {
		return fmt.Errorf("storage: log listen: %w", err)
	}
	return nil
}

// MusicLeaderboard returns the top listeners by total listening time.
func (s *Store) MusicLeaderboard(ctx context.Context, guildID string, limit int) ([]ListenerStats, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT odUserId, odUsername,
		        COALESCE(SUM(durationSeconds), 0) AS totalSeconds,
		        COUNT(*) AS playCount,
		        COUNT(DISTINCT CONCAT(trackTitle, trackArtist)) AS uniqueTracks
		   FROM ListeningHistory WHERE guildId = ?
		  GROUP BY odUserId, odUsername
		  ORDER BY totalSeconds DESC LIMIT ?`, guildID, limit)
	if err != nil {
		return nil, fmt.Errorf("storage: music leaderboard: %w", err)
	}
	defer rows.Close()

	var out []ListenerStats
	for rows.Next() {
		var l ListenerStats
		if err := rows.Scan(&l.UserID, &l.Username, &l.TotalSeconds, &l.PlayCount, &l.UniqueTracks); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// MostPlayedTrack returns the single most-played track in a guild (nil if none).
func (s *Store) MostPlayedTrack(ctx context.Context, guildID string) (*TrackPlays, error) {
	var t TrackPlays
	var artist *string
	err := s.db.QueryRowContext(ctx,
		`SELECT trackTitle, trackArtist, COUNT(*) AS plays
		   FROM ListeningHistory WHERE guildId = ?
		  GROUP BY trackTitle, trackArtist
		  ORDER BY plays DESC LIMIT 1`, guildID).Scan(&t.Title, &artist, &t.PlayCount)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("storage: most played track: %w", err)
	}
	if artist != nil {
		t.Artist = *artist
	}
	return &t, nil
}

// UserWrappedStats returns a user's aggregate listening stats for a guild.
func (s *Store) UserWrappedStats(ctx context.Context, guildID, userID string) (*WrappedStats, error) {
	var st WrappedStats
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*),
		        COALESCE(SUM(durationSeconds), 0),
		        COUNT(DISTINCT CONCAT(trackTitle, trackArtist))
		   FROM ListeningHistory WHERE guildId = ? AND odUserId = ?`,
		guildID, userID).Scan(&st.TotalTracks, &st.TotalSeconds, &st.UniqueTracks)
	if err != nil {
		return nil, fmt.Errorf("storage: user wrapped stats: %w", err)
	}
	return &st, nil
}

// GuildWrappedStats returns guild-wide aggregate listening stats.
func (s *Store) GuildWrappedStats(ctx context.Context, guildID string) (*WrappedStats, error) {
	var st WrappedStats
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*),
		        COALESCE(SUM(durationSeconds), 0),
		        COUNT(DISTINCT trackArtist)
		   FROM ListeningHistory WHERE guildId = ?`,
		guildID).Scan(&st.TotalTracks, &st.TotalSeconds, &st.UniqueArtists)
	if err != nil {
		return nil, fmt.Errorf("storage: guild wrapped stats: %w", err)
	}
	return &st, nil
}

// TopTracks returns the most-played tracks, guild-wide or for one user
// (userID empty = guild-wide).
func (s *Store) TopTracks(ctx context.Context, guildID, userID string, limit int) ([]TrackPlays, error) {
	query := `SELECT trackTitle, trackArtist, COUNT(*) AS plays
	            FROM ListeningHistory WHERE guildId = ?`
	args := []any{guildID}
	if userID != "" {
		query += ` AND odUserId = ?`
		args = append(args, userID)
	}
	query += ` GROUP BY trackTitle, trackArtist ORDER BY plays DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("storage: top tracks: %w", err)
	}
	defer rows.Close()

	var out []TrackPlays
	for rows.Next() {
		var t TrackPlays
		var artist *string
		if err := rows.Scan(&t.Title, &artist, &t.PlayCount); err != nil {
			return nil, err
		}
		if artist != nil {
			t.Artist = *artist
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// TopArtists returns the most-played artists, guild-wide or for one user.
func (s *Store) TopArtists(ctx context.Context, guildID, userID string, limit int) ([]ArtistPlays, error) {
	query := `SELECT trackArtist, COUNT(*) AS plays
	            FROM ListeningHistory WHERE guildId = ? AND trackArtist IS NOT NULL`
	args := []any{guildID}
	if userID != "" {
		query += ` AND odUserId = ?`
		args = append(args, userID)
	}
	query += ` GROUP BY trackArtist ORDER BY plays DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("storage: top artists: %w", err)
	}
	defer rows.Close()

	var out []ArtistPlays
	for rows.Next() {
		var a ArtistPlays
		if err := rows.Scan(&a.Artist, &a.PlayCount); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// TopListeners returns the top listeners by total time (used by /wrapped server).
func (s *Store) TopListeners(ctx context.Context, guildID string, limit int) ([]ListenerStats, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT odUserId, COALESCE(SUM(durationSeconds), 0) AS totalSeconds, COUNT(*) AS playCount
		   FROM ListeningHistory WHERE guildId = ?
		  GROUP BY odUserId ORDER BY totalSeconds DESC LIMIT ?`, guildID, limit)
	if err != nil {
		return nil, fmt.Errorf("storage: top listeners: %w", err)
	}
	defer rows.Close()

	var out []ListenerStats
	for rows.Next() {
		var l ListenerStats
		if err := rows.Scan(&l.UserID, &l.TotalSeconds, &l.PlayCount); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// FavoriteHour returns the hour-of-day (0–23) a user plays the most music,
// or -1 when there is no data.
func (s *Store) FavoriteHour(ctx context.Context, guildID, userID string) (int, error) {
	var hour int
	err := s.db.QueryRowContext(ctx,
		`SELECT HOUR(playedAt) AS hour FROM ListeningHistory
		  WHERE guildId = ? AND odUserId = ?
		  GROUP BY HOUR(playedAt) ORDER BY COUNT(*) DESC LIMIT 1`,
		guildID, userID).Scan(&hour)
	if err != nil {
		if isNoRows(err) {
			return -1, nil
		}
		return -1, fmt.Errorf("storage: favorite hour: %w", err)
	}
	return hour, nil
}
