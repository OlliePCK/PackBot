package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// Poll is one row of the Polls table. Votes maps option index (as a string,
// "0".."3" — parity with the Node JSON shape) to the user IDs who chose it.
type Poll struct {
	ID        int64
	GuildID   string
	ChannelID string
	MessageID string
	Question  string
	Options   []string
	Votes     map[string][]string
	CreatedBy string
	ExpiresAt time.Time
	Closed    bool
}

// CreatePoll persists a new poll.
func (s *Store) CreatePoll(ctx context.Context, p *Poll) error {
	options, err := json.Marshal(p.Options)
	if err != nil {
		return fmt.Errorf("storage: marshal poll options: %w", err)
	}
	votes, err := json.Marshal(p.Votes)
	if err != nil {
		return fmt.Errorf("storage: marshal poll votes: %w", err)
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO Polls (guildId, channelId, messageId, question, options, votes, createdBy, expiresAt)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		p.GuildID, p.ChannelID, p.MessageID, p.Question, options, votes, p.CreatedBy, p.ExpiresAt)
	if err != nil {
		return fmt.Errorf("storage: create poll: %w", err)
	}
	return nil
}

// CastVote records a user's vote on an open poll, atomically: the row is
// locked (SELECT ... FOR UPDATE) so concurrent button clicks can't clobber
// each other's read-modify-write on the votes JSON. The user's previous vote,
// if any, moves to the new option. Returns the updated poll, or nil if the
// poll is closed/expired/unknown.
func (s *Store) CastVote(ctx context.Context, messageID, userID string, optionIndex int) (*Poll, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("storage: begin vote tx: %w", err)
	}
	defer tx.Rollback() // no-op after Commit

	p, err := scanPoll(tx.QueryRowContext(ctx,
		`SELECT id, guildId, channelId, messageId, question, options, votes, createdBy, expiresAt, closed
		   FROM Polls WHERE messageId = ? FOR UPDATE`, messageID))
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, err
	}
	if p.Closed || time.Now().After(p.ExpiresAt) {
		return nil, nil
	}
	if optionIndex < 0 || optionIndex >= len(p.Options) {
		return nil, fmt.Errorf("storage: vote for invalid option %d", optionIndex)
	}

	ApplyVote(p.Votes, userID, optionIndex)

	votes, err := json.Marshal(p.Votes)
	if err != nil {
		return nil, fmt.Errorf("storage: marshal votes: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE Polls SET votes = ? WHERE id = ?`, votes, p.ID); err != nil {
		return nil, fmt.Errorf("storage: update votes: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("storage: commit vote: %w", err)
	}
	return p, nil
}

// ApplyVote moves a user's vote to optionIndex in place: any previous vote is
// removed, then the user is appended to the chosen option (parity with the
// Node collector's revote behaviour).
func ApplyVote(votes map[string][]string, userID string, optionIndex int) {
	for key, users := range votes {
		filtered := users[:0]
		for _, id := range users {
			if id != userID {
				filtered = append(filtered, id)
			}
		}
		votes[key] = filtered
	}
	key := fmt.Sprintf("%d", optionIndex)
	votes[key] = append(votes[key], userID)
}

// ExpiredOpenPolls returns polls past their expiry that are still open.
func (s *Store) ExpiredOpenPolls(ctx context.Context) ([]*Poll, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, guildId, channelId, messageId, question, options, votes, createdBy, expiresAt, closed
		   FROM Polls WHERE closed = 0 AND expiresAt <= NOW()`)
	if err != nil {
		return nil, fmt.Errorf("storage: expired polls: %w", err)
	}
	defer rows.Close()

	var out []*Poll
	for rows.Next() {
		p, err := scanPoll(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ClosePoll marks a poll closed.
func (s *Store) ClosePoll(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE Polls SET closed = 1 WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("storage: close poll: %w", err)
	}
	return nil
}

// rowScanner covers both *sql.Row and *sql.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanPoll(row rowScanner) (*Poll, error) {
	var p Poll
	var options, votes []byte
	var closed int
	if err := row.Scan(&p.ID, &p.GuildID, &p.ChannelID, &p.MessageID, &p.Question,
		&options, &votes, &p.CreatedBy, &p.ExpiresAt, &closed); err != nil {
		if isNoRows(err) {
			return nil, sql.ErrNoRows
		}
		return nil, fmt.Errorf("storage: scan poll: %w", err)
	}
	p.Closed = closed != 0
	if err := json.Unmarshal(options, &p.Options); err != nil {
		return nil, fmt.Errorf("storage: unmarshal poll options: %w", err)
	}
	if err := json.Unmarshal(votes, &p.Votes); err != nil {
		return nil, fmt.Errorf("storage: unmarshal poll votes: %w", err)
	}
	if p.Votes == nil {
		p.Votes = make(map[string][]string)
	}
	return &p, nil
}
