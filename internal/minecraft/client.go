package minecraft

import (
	"context"
	"errors"
	"strings"
)

// ErrNotConfigured is returned when a nil Client is used — i.e. MC_ADDRESS was
// never set. Commands surface this as a friendly "not configured" reply rather
// than an error embed.
var ErrNotConfigured = errors.New("minecraft: no server address configured")

// Client queries a single Minecraft server.
//
// A nil *Client is the valid "feature disabled" state, mirroring how the
// YouTube, Music and AFL dependencies degrade when their config is absent —
// callers can hold a nil Client and still call Ping safely.
type Client struct {
	Addr string
}

// New returns a Client for addr, or nil when addr is empty so the caller can
// store the result directly in commands.Deps without a branch.
func New(addr string) *Client {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return nil
	}
	return &Client{Addr: addr}
}

// Ping fetches the server status. Safe to call on a nil Client.
func (c *Client) Ping(ctx context.Context) (*Status, error) {
	if c == nil {
		return nil, ErrNotConfigured
	}
	return Ping(ctx, c.Addr)
}
