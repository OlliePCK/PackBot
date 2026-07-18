package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrSessionNotFound reports a missing or expired persisted session.
var ErrSessionNotFound = errors.New("storage: session not found")

// SaveSession upserts a web session (data is the serialized session user).
func (s *Store) SaveSession(ctx context.Context, sessionID, userID string, data []byte, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO Sessions (sessionId, userId, data, expiresAt) VALUES (?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE userId = VALUES(userId), data = VALUES(data), expiresAt = VALUES(expiresAt)`,
		sessionID, userID, data, expiresAt)
	if err != nil {
		return fmt.Errorf("storage: save session: %w", err)
	}
	return nil
}

// LoadSession fetches a persisted, unexpired session's data and expiry.
func (s *Store) LoadSession(ctx context.Context, sessionID string) ([]byte, time.Time, error) {
	var data []byte
	var expiresAt time.Time
	err := s.db.QueryRowContext(ctx,
		`SELECT data, expiresAt FROM Sessions WHERE sessionId = ? AND expiresAt > NOW() LIMIT 1`,
		sessionID).Scan(&data, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, time.Time{}, ErrSessionNotFound
	}
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("storage: load session: %w", err)
	}
	return data, expiresAt, nil
}

// DeleteSession removes a persisted session (logout).
func (s *Store) DeleteSession(ctx context.Context, sessionID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM Sessions WHERE sessionId = ?`, sessionID)
	if err != nil {
		return fmt.Errorf("storage: delete session: %w", err)
	}
	return nil
}

// DeleteExpiredSessions clears out sessions past their expiry.
func (s *Store) DeleteExpiredSessions(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM Sessions WHERE expiresAt <= NOW()`)
	if err != nil {
		return 0, fmt.Errorf("storage: delete expired sessions: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}
