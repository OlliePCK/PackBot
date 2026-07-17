package storage

// Queries whose response shapes exist only for the web API (api/WebAPI.js).
// Command-facing queries live in the per-domain files; these variants differ
// in grouping (thumbnails included), pagination, or multi-guild scope.

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// inPlaceholders returns "?,?,?" for n parameters.
func inPlaceholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func toAny(ids []string) []any {
	out := make([]any, len(ids))
	for i, id := range ids {
		out[i] = id
	}
	return out
}

// HistoryEntry is one paginated ListeningHistory row for the API.
type HistoryEntry struct {
	ID        int64
	Title     string
	Artist    *string
	URL       *string
	Thumbnail *string
	Duration  int
	UserID    string
	Username  string
	PlayedAt  time.Time
}

// HistoryPage returns one page of a guild's listening history plus the total
// row count. userID optionally filters to one requester.
func (s *Store) HistoryPage(ctx context.Context, guildID, userID string, page, limit int) ([]HistoryEntry, int, error) {
	countQuery := `SELECT COUNT(*) FROM ListeningHistory WHERE guildId = ?`
	dataQuery := `SELECT id, trackTitle, trackArtist, trackUrl, trackThumbnail, durationSeconds, odUserId, odUsername, playedAt
	                FROM ListeningHistory WHERE guildId = ?`
	args := []any{guildID}
	if userID != "" {
		countQuery += ` AND odUserId = ?`
		dataQuery += ` AND odUserId = ?`
		args = append(args, userID)
	}
	dataQuery += ` ORDER BY playedAt DESC LIMIT ? OFFSET ?`

	var total int
	if err := s.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("storage: history count: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, dataQuery, append(args, limit, (page-1)*limit)...)
	if err != nil {
		return nil, 0, fmt.Errorf("storage: history page: %w", err)
	}
	defer rows.Close()

	var out []HistoryEntry
	for rows.Next() {
		var e HistoryEntry
		if err := rows.Scan(&e.ID, &e.Title, &e.Artist, &e.URL, &e.Thumbnail, &e.Duration, &e.UserID, &e.Username, &e.PlayedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, e)
	}
	return out, total, rows.Err()
}

// APITrack is a top-track row with display fields (API grouping includes
// url/thumbnail, unlike the command variant).
type APITrack struct {
	Title         string  `json:"title"`
	Artist        *string `json:"artist"`
	URL           *string `json:"url,omitempty"`
	Thumbnail     *string `json:"thumbnail"`
	PlayCount     int     `json:"playCount"`
	TotalDuration *int64  `json:"totalDuration,omitempty"`
}

// APIUserPlays is a per-user play aggregate for API responses.
type APIUserPlays struct {
	UserID        string `json:"odUserId"`
	Username      string `json:"username"`
	PlayCount     int    `json:"playCount"`
	TotalDuration int64  `json:"totalDuration"`
}

// HourCount is plays per hour-of-day.
type HourCount struct {
	Hour  int `json:"hour"`
	Count int `json:"count"`
}

// GuildHistoryStats aggregates a guild's listening history for the API.
type GuildHistoryStats struct {
	TotalTracks    int
	TotalSeconds   int64
	TopTracks      []APITrack
	TopUsers       []APIUserPlays
	HourlyActivity []HourCount
}

// HistoryStats returns the /history/:guildId/stats aggregate.
func (s *Store) HistoryStats(ctx context.Context, guildID string) (*GuildHistoryStats, error) {
	st := &GuildHistoryStats{}

	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*), COALESCE(SUM(durationSeconds), 0) FROM ListeningHistory WHERE guildId = ?`,
		guildID).Scan(&st.TotalTracks, &st.TotalSeconds)
	if err != nil {
		return nil, fmt.Errorf("storage: history stats: %w", err)
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT trackTitle, trackArtist, trackUrl, trackThumbnail, COUNT(*) AS plays, SUM(durationSeconds)
		   FROM ListeningHistory WHERE guildId = ?
		  GROUP BY trackTitle, trackArtist, trackUrl, trackThumbnail
		  ORDER BY plays DESC LIMIT 10`, guildID)
	if err != nil {
		return nil, fmt.Errorf("storage: history top tracks: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var t APITrack
		if err := rows.Scan(&t.Title, &t.Artist, &t.URL, &t.Thumbnail, &t.PlayCount, &t.TotalDuration); err != nil {
			return nil, err
		}
		st.TopTracks = append(st.TopTracks, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	userRows, err := s.db.QueryContext(ctx,
		`SELECT odUserId, odUsername, COUNT(*) AS plays, COALESCE(SUM(durationSeconds), 0)
		   FROM ListeningHistory WHERE guildId = ?
		  GROUP BY odUserId, odUsername ORDER BY plays DESC LIMIT 10`, guildID)
	if err != nil {
		return nil, fmt.Errorf("storage: history top users: %w", err)
	}
	defer userRows.Close()
	for userRows.Next() {
		var u APIUserPlays
		if err := userRows.Scan(&u.UserID, &u.Username, &u.PlayCount, &u.TotalDuration); err != nil {
			return nil, err
		}
		st.TopUsers = append(st.TopUsers, u)
	}
	if err := userRows.Err(); err != nil {
		return nil, err
	}

	hourRows, err := s.db.QueryContext(ctx,
		`SELECT HOUR(playedAt) AS hour, COUNT(*) FROM ListeningHistory
		  WHERE guildId = ? AND playedAt > DATE_SUB(NOW(), INTERVAL 30 DAY)
		  GROUP BY HOUR(playedAt) ORDER BY hour`, guildID)
	if err != nil {
		return nil, fmt.Errorf("storage: history hourly: %w", err)
	}
	defer hourRows.Close()
	for hourRows.Next() {
		var h HourCount
		if err := hourRows.Scan(&h.Hour, &h.Count); err != nil {
			return nil, err
		}
		st.HourlyActivity = append(st.HourlyActivity, h)
	}
	return st, hourRows.Err()
}

// ProfileStats is a user's aggregate across a set of guilds.
type ProfileStats struct {
	TotalTracks  int
	TotalSeconds int64
	GuildsActive int
}

// UserProfileStats aggregates a user's listening across the given guilds.
func (s *Store) UserProfileStats(ctx context.Context, userID string, guildIDs []string) (*ProfileStats, error) {
	if len(guildIDs) == 0 {
		return &ProfileStats{}, nil
	}
	var st ProfileStats
	query := fmt.Sprintf(
		`SELECT COUNT(*), COALESCE(SUM(durationSeconds), 0), COUNT(DISTINCT guildId)
		   FROM ListeningHistory WHERE odUserId = ? AND guildId IN (%s)`, inPlaceholders(len(guildIDs)))
	err := s.db.QueryRowContext(ctx, query, append([]any{userID}, toAny(guildIDs)...)...).
		Scan(&st.TotalTracks, &st.TotalSeconds, &st.GuildsActive)
	if err != nil {
		return nil, fmt.Errorf("storage: profile stats: %w", err)
	}
	return &st, nil
}

// LatestUsername returns the user's most recently recorded username, or "".
func (s *Store) LatestUsername(ctx context.Context, userID string) (string, error) {
	var name string
	err := s.db.QueryRowContext(ctx,
		`SELECT odUsername FROM ListeningHistory WHERE odUserId = ? ORDER BY playedAt DESC LIMIT 1`,
		userID).Scan(&name)
	if err != nil {
		if isNoRows(err) {
			return "", nil
		}
		return "", fmt.Errorf("storage: latest username: %w", err)
	}
	return name, nil
}

// TopTracksAPI returns most-played tracks (with thumbnails) across guilds,
// optionally per user.
func (s *Store) TopTracksAPI(ctx context.Context, guildIDs []string, userID string, limit int) ([]APITrack, error) {
	if len(guildIDs) == 0 {
		return nil, nil
	}
	query := fmt.Sprintf(
		`SELECT trackTitle, trackArtist, trackThumbnail, COUNT(*) AS plays
		   FROM ListeningHistory WHERE guildId IN (%s)`, inPlaceholders(len(guildIDs)))
	args := toAny(guildIDs)
	if userID != "" {
		query += ` AND odUserId = ?`
		args = append(args, userID)
	}
	query += ` GROUP BY trackTitle, trackArtist, trackThumbnail ORDER BY plays DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("storage: api top tracks: %w", err)
	}
	defer rows.Close()

	var out []APITrack
	for rows.Next() {
		var t APITrack
		if err := rows.Scan(&t.Title, &t.Artist, &t.Thumbnail, &t.PlayCount); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// TopArtistsAPI returns most-played artists across guilds, optionally per user.
func (s *Store) TopArtistsAPI(ctx context.Context, guildIDs []string, userID string, limit int) ([]ArtistPlays, error) {
	if len(guildIDs) == 0 {
		return nil, nil
	}
	query := fmt.Sprintf(
		`SELECT trackArtist, COUNT(*) AS plays
		   FROM ListeningHistory WHERE trackArtist IS NOT NULL AND guildId IN (%s)`, inPlaceholders(len(guildIDs)))
	args := toAny(guildIDs)
	if userID != "" {
		query += ` AND odUserId = ?`
		args = append(args, userID)
	}
	query += ` GROUP BY trackArtist ORDER BY plays DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("storage: api top artists: %w", err)
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

// RecentPlay is one row of a profile's recent plays.
type RecentPlay struct {
	Title     string    `json:"title"`
	Artist    *string   `json:"artist"`
	Thumbnail *string   `json:"thumbnail"`
	PlayedAt  time.Time `json:"playedAt"`
	Duration  int       `json:"durationSeconds"`
}

// RecentPlays returns a user's most recent plays across guilds.
func (s *Store) RecentPlays(ctx context.Context, guildIDs []string, userID string, limit int) ([]RecentPlay, error) {
	if len(guildIDs) == 0 {
		return nil, nil
	}
	query := fmt.Sprintf(
		`SELECT trackTitle, trackArtist, trackThumbnail, playedAt, durationSeconds
		   FROM ListeningHistory WHERE odUserId = ? AND guildId IN (%s)
		  ORDER BY playedAt DESC LIMIT ?`, inPlaceholders(len(guildIDs)))
	rows, err := s.db.QueryContext(ctx, query, append(append([]any{userID}, toAny(guildIDs)...), limit)...)
	if err != nil {
		return nil, fmt.Errorf("storage: recent plays: %w", err)
	}
	defer rows.Close()

	var out []RecentPlay
	for rows.Next() {
		var p RecentPlay
		if err := rows.Scan(&p.Title, &p.Artist, &p.Thumbnail, &p.PlayedAt, &p.Duration); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// UserPlaytimeWithName returns a user's per-game playtime plus their stored
// username (fixing the Node API bug where the username was never selected).
func (s *Store) UserPlaytimeWithName(ctx context.Context, guildID, userID string) ([]PlaytimeEntry, string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT gameName, totalSeconds, lastPlayed, odUsername
		   FROM Playtime WHERE guildId = ? AND odUserId = ?
		  ORDER BY totalSeconds DESC`, guildID, userID)
	if err != nil {
		return nil, "", fmt.Errorf("storage: user playtime api: %w", err)
	}
	defer rows.Close()

	var out []PlaytimeEntry
	var username string
	for rows.Next() {
		var e PlaytimeEntry
		if err := rows.Scan(&e.GameName, &e.TotalSeconds, &e.LastPlayed, &e.Username); err != nil {
			return nil, "", err
		}
		if username == "" {
			username = e.Username
		}
		out = append(out, e)
	}
	return out, username, rows.Err()
}

// GameNames lists a guild's distinct tracked games alphabetically.
func (s *Store) GameNames(ctx context.Context, guildID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT DISTINCT gameName FROM Playtime WHERE guildId = ? ORDER BY gameName`, guildID)
	if err != nil {
		return nil, fmt.Errorf("storage: game names: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// APIPlaylist is a saved playlist row with its ID (API responses expose it).
type APIPlaylist struct {
	ID        int64     `json:"id"`
	GuildID   string    `json:"guildId"`
	Name      string    `json:"name"`
	URL       string    `json:"url"`
	Platform  string    `json:"platform"`
	CreatedAt time.Time `json:"createdAt"`
}

// ListPlaylistsAcrossGuilds returns a user's playlists in the given guilds.
func (s *Store) ListPlaylistsAcrossGuilds(ctx context.Context, userID string, guildIDs []string) ([]APIPlaylist, error) {
	if len(guildIDs) == 0 {
		return nil, nil
	}
	query := fmt.Sprintf(
		`SELECT id, guildId, name, url, platform, createdAt FROM SavedPlaylists
		  WHERE userId = ? AND guildId IN (%s) ORDER BY name`, inPlaceholders(len(guildIDs)))
	rows, err := s.db.QueryContext(ctx, query, append([]any{userID}, toAny(guildIDs)...)...)
	if err != nil {
		return nil, fmt.Errorf("storage: playlists across guilds: %w", err)
	}
	defer rows.Close()

	var out []APIPlaylist
	for rows.Next() {
		var p APIPlaylist
		if err := rows.Scan(&p.ID, &p.GuildID, &p.Name, &p.URL, &p.Platform, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// UpsertPlaylistNoCap inserts/updates a saved playlist without the 25-row cap
// (parity: the Node API endpoint never enforced the command's cap).
func (s *Store) UpsertPlaylistNoCap(ctx context.Context, guildID, userID, name, url, platform string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO SavedPlaylists (guildId, userId, name, url, platform)
		 VALUES (?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE url = VALUES(url), platform = VALUES(platform)`,
		guildID, userID, name, url, platform)
	if err != nil {
		return fmt.Errorf("storage: upsert playlist: %w", err)
	}
	return nil
}

// DeletePlaylistByID deletes a playlist row owned by the user.
func (s *Store) DeletePlaylistByID(ctx context.Context, id int64, userID string) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM SavedPlaylists WHERE id = ? AND userId = ?`, id, userID)
	if err != nil {
		return false, fmt.Errorf("storage: delete playlist by id: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// FavoriteGuild returns the user's favorite guild preference (nil when unset).
func (s *Store) FavoriteGuild(ctx context.Context, userID string) (*string, error) {
	var fav *string
	err := s.db.QueryRowContext(ctx,
		`SELECT favoriteGuildId FROM UserPreferences WHERE odUserId = ?`, userID).Scan(&fav)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("storage: favorite guild: %w", err)
	}
	return fav, nil
}

// SetFavoriteGuild upserts the user's favorite guild (nil clears it).
func (s *Store) SetFavoriteGuild(ctx context.Context, userID string, guildID *string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO UserPreferences (odUserId, favoriteGuildId) VALUES (?, ?)
		 ON DUPLICATE KEY UPDATE favoriteGuildId = VALUES(favoriteGuildId)`,
		userID, guildID)
	if err != nil {
		return fmt.Errorf("storage: set favorite guild: %w", err)
	}
	return nil
}
