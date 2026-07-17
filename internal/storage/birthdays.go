package storage

import (
	"context"
	"fmt"
)

// Birthday is one row of the Birthdays table.
type Birthday struct {
	UserID string
	Name   string
	Month  int
	Day    int
}

// UpsertBirthday adds or updates a member's birthday (unique per user+guild).
func (s *Store) UpsertBirthday(ctx context.Context, guildID, userID, name string, month, day int) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO Birthdays (guildId, userId, name, birthMonth, birthDay)
		 VALUES (?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE name = VALUES(name), birthMonth = VALUES(birthMonth), birthDay = VALUES(birthDay)`,
		guildID, userID, name, month, day)
	if err != nil {
		return fmt.Errorf("storage: upsert birthday: %w", err)
	}
	return nil
}

// DeleteBirthday removes a member's birthday; reports whether a row existed.
func (s *Store) DeleteBirthday(ctx context.Context, guildID, userID string) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM Birthdays WHERE userId = ? AND guildId = ?`, userID, guildID)
	if err != nil {
		return false, fmt.Errorf("storage: delete birthday: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// GuildBirthday is a birthday joined with its guild's announcement channel.
type GuildBirthday struct {
	Birthday
	GuildID          string
	GeneralChannelID string
}

// BirthdaysOn returns all birthdays falling on the given month/day across
// guilds that have a general channel configured (the reminders job's query).
func (s *Store) BirthdaysOn(ctx context.Context, month, day int) ([]GuildBirthday, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT b.userId, b.name, b.birthMonth, b.birthDay, b.guildId, g.generalChannelID
		   FROM Birthdays b
		   JOIN Guilds g ON g.guildId = b.guildId
		  WHERE b.birthMonth = ? AND b.birthDay = ? AND g.generalChannelID IS NOT NULL`,
		month, day)
	if err != nil {
		return nil, fmt.Errorf("storage: birthdays on date: %w", err)
	}
	defer rows.Close()

	var out []GuildBirthday
	for rows.Next() {
		var b GuildBirthday
		if err := rows.Scan(&b.UserID, &b.Name, &b.Month, &b.Day, &b.GuildID, &b.GeneralChannelID); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// ListBirthdays returns all birthdays in a guild ordered by date.
func (s *Store) ListBirthdays(ctx context.Context, guildID string) ([]Birthday, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT userId, name, birthMonth, birthDay FROM Birthdays
		  WHERE guildId = ? ORDER BY birthMonth, birthDay`, guildID)
	if err != nil {
		return nil, fmt.Errorf("storage: list birthdays: %w", err)
	}
	defer rows.Close()

	var out []Birthday
	for rows.Next() {
		var b Birthday
		if err := rows.Scan(&b.UserID, &b.Name, &b.Month, &b.Day); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}
