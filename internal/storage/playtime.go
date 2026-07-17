package storage

import (
	"context"
	"fmt"
	"time"
)

// PlaytimeEntry is one leaderboard row (user × seconds, optionally per game).
type PlaytimeEntry struct {
	UserID       string
	Username     string
	GameName     string
	TotalSeconds int64
	LastPlayed   time.Time
}

// GameTotal is one row of the most-played-games leaderboard.
type GameTotal struct {
	GameName     string
	TotalSeconds int64
	Players      int
}

// RecordPlaytime accumulates a finished play session into the user's total
// for that game (parity with game-expose's upsert).
func (s *Store) RecordPlaytime(ctx context.Context, guildID, userID, username, gameName string, seconds int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO Playtime (guildId, odUserId, odUsername, gameName, totalSeconds)
		 VALUES (?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE
		   totalSeconds = totalSeconds + VALUES(totalSeconds),
		   odUsername   = VALUES(odUsername),
		   lastPlayed   = CURRENT_TIMESTAMP`,
		guildID, userID, username, gameName, seconds)
	if err != nil {
		return fmt.Errorf("storage: record playtime: %w", err)
	}
	return nil
}

// TopPlaytimeTotal returns the top users by summed playtime across all games.
func (s *Store) TopPlaytimeTotal(ctx context.Context, guildID string, limit int) ([]PlaytimeEntry, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT odUserId, odUsername, SUM(totalSeconds) AS total
		   FROM Playtime WHERE guildId = ?
		  GROUP BY odUserId, odUsername
		  ORDER BY total DESC LIMIT ?`, guildID, limit)
	if err != nil {
		return nil, fmt.Errorf("storage: playtime total leaderboard: %w", err)
	}
	defer rows.Close()

	var out []PlaytimeEntry
	for rows.Next() {
		var e PlaytimeEntry
		if err := rows.Scan(&e.UserID, &e.Username, &e.TotalSeconds); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// TopPlaytimeForGame returns the top users for one game.
func (s *Store) TopPlaytimeForGame(ctx context.Context, guildID, gameName string, limit int) ([]PlaytimeEntry, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT odUserId, odUsername, totalSeconds
		   FROM Playtime WHERE guildId = ? AND gameName = ?
		  ORDER BY totalSeconds DESC LIMIT ?`, guildID, gameName, limit)
	if err != nil {
		return nil, fmt.Errorf("storage: playtime game leaderboard: %w", err)
	}
	defer rows.Close()

	var out []PlaytimeEntry
	for rows.Next() {
		var e PlaytimeEntry
		if err := rows.Scan(&e.UserID, &e.Username, &e.TotalSeconds); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// UserPlaytime returns a user's most-played games.
func (s *Store) UserPlaytime(ctx context.Context, guildID, userID string, limit int) ([]PlaytimeEntry, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT gameName, totalSeconds, lastPlayed
		   FROM Playtime WHERE guildId = ? AND odUserId = ?
		  ORDER BY totalSeconds DESC LIMIT ?`, guildID, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("storage: user playtime: %w", err)
	}
	defer rows.Close()

	var out []PlaytimeEntry
	for rows.Next() {
		var e PlaytimeEntry
		if err := rows.Scan(&e.GameName, &e.TotalSeconds, &e.LastPlayed); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// TopGames returns the most-played games in a guild.
func (s *Store) TopGames(ctx context.Context, guildID string, limit int) ([]GameTotal, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT gameName, SUM(totalSeconds) AS total, COUNT(DISTINCT odUserId) AS players
		   FROM Playtime WHERE guildId = ?
		  GROUP BY gameName ORDER BY total DESC LIMIT ?`, guildID, limit)
	if err != nil {
		return nil, fmt.Errorf("storage: top games: %w", err)
	}
	defer rows.Close()

	var out []GameTotal
	for rows.Next() {
		var g GameTotal
		if err := rows.Scan(&g.GameName, &g.TotalSeconds, &g.Players); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// SearchGameNames returns up to 25 distinct game names matching a substring,
// most-played first (used by /leaderboard game autocomplete).
func (s *Store) SearchGameNames(ctx context.Context, guildID, query string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT gameName FROM Playtime
		  WHERE guildId = ? AND gameName LIKE ?
		  GROUP BY gameName ORDER BY MAX(totalSeconds) DESC LIMIT 25`,
		guildID, "%"+query+"%")
	if err != nil {
		return nil, fmt.Errorf("storage: search game names: %w", err)
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
