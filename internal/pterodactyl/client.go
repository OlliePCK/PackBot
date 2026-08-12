// Package pterodactyl is a minimal client for the Pterodactyl panel's client
// API — only the operations /mc wipe needs: power control, backups, and file
// manipulation inside one server.
//
// RCON can already run console commands, so this exists for the things RCON
// cannot do: stopping the server in a way wings honours (an RCON "stop" is
// treated as a crash and restarted within seconds), deleting the world, and
// editing server.properties while the server is down.
package pterodactyl

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client talks to one server on a Pterodactyl panel.
type Client struct {
	baseURL  string // panel root, no trailing slash
	apiKey   string // client API key ("ptlc_...")
	serverID string // short server ID from the panel URL
	http     *http.Client
}

// New returns a client, or nil when any setting is missing so callers can
// degrade gracefully the same way the RCON and map integrations do.
func New(baseURL, apiKey, serverID string) *Client {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	apiKey = strings.TrimSpace(apiKey)
	serverID = strings.TrimSpace(serverID)
	if baseURL == "" || apiKey == "" || serverID == "" {
		return nil
	}
	return &Client{
		baseURL:  baseURL,
		apiKey:   apiKey,
		serverID: serverID,
		http:     &http.Client{Timeout: 30 * time.Second},
	}
}

// do issues one API call. body may be nil. When out is non-nil the JSON
// response is decoded into it; many endpoints return 204 with no body.
func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("pterodactyl: encode body: %w", err)
		}
		rdr = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method,
		c.baseURL+"/api/client/servers/"+c.serverID+path, rdr)
	if err != nil {
		return fmt.Errorf("pterodactyl: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("pterodactyl: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		// Panel errors carry a JSON body describing the problem; include a
		// bounded slice of it, since "422" alone is not actionable.
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("pterodactyl: %s %s: status %d: %s",
			method, path, resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("pterodactyl: decode %s: %w", path, err)
	}
	return nil
}

// State reports the server's power state: "running", "offline", "starting" or
// "stopping".
func (c *Client) State(ctx context.Context) (string, error) {
	var out struct {
		Attributes struct {
			CurrentState string `json:"current_state"`
		} `json:"attributes"`
	}
	if err := c.do(ctx, http.MethodGet, "/resources", nil, &out); err != nil {
		return "", err
	}
	return out.Attributes.CurrentState, nil
}

// Power sends a power signal: "start", "stop", "restart" or "kill".
func (c *Client) Power(ctx context.Context, signal string) error {
	return c.do(ctx, http.MethodPost, "/power",
		map[string]string{"signal": signal}, nil)
}

// WaitForState polls until the server reaches want, or the context expires.
//
// Polling rather than trusting the power call is the point: a wipe must not
// start deleting files while the server is still flushing chunks to disk.
func (c *Client) WaitForState(ctx context.Context, want string) error {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		state, err := c.State(ctx)
		if err != nil {
			return err
		}
		if state == want {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("pterodactyl: timed out waiting for state %q (last %q)", want, state)
		case <-ticker.C:
		}
	}
}

// CreateBackup starts a backup and returns its UUID.
func (c *Client) CreateBackup(ctx context.Context, name string) (string, error) {
	var out struct {
		Attributes struct {
			UUID string `json:"uuid"`
		} `json:"attributes"`
	}
	if err := c.do(ctx, http.MethodPost, "/backups",
		map[string]string{"name": name}, &out); err != nil {
		return "", err
	}
	return out.Attributes.UUID, nil
}

// WaitForBackup polls until the backup finishes, returning an error if it
// completes unsuccessfully or the context expires.
func (c *Client) WaitForBackup(ctx context.Context, uuid string) error {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		var out struct {
			Attributes struct {
				IsSuccessful bool   `json:"is_successful"`
				CompletedAt  string `json:"completed_at"`
				Bytes        int64  `json:"bytes"`
			} `json:"attributes"`
		}
		if err := c.do(ctx, http.MethodGet, "/backups/"+uuid, nil, &out); err != nil {
			return err
		}
		if out.Attributes.CompletedAt != "" {
			if !out.Attributes.IsSuccessful {
				return fmt.Errorf("pterodactyl: backup %s completed unsuccessfully", uuid)
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("pterodactyl: timed out waiting for backup %s", uuid)
		case <-ticker.C:
		}
	}
}

// FileEntry is one item in a directory listing.
type FileEntry struct {
	Name   string `json:"name"`
	IsFile bool   `json:"is_file"`
}

// ListFiles lists a directory, e.g. "/world".
func (c *Client) ListFiles(ctx context.Context, dir string) ([]FileEntry, error) {
	var out struct {
		Data []struct {
			Attributes FileEntry `json:"attributes"`
		} `json:"data"`
	}
	if err := c.do(ctx, http.MethodGet,
		"/files/list?directory="+url.QueryEscape(dir), nil, &out); err != nil {
		return nil, err
	}
	entries := make([]FileEntry, 0, len(out.Data))
	for _, d := range out.Data {
		entries = append(entries, d.Attributes)
	}
	return entries, nil
}

// DeleteFiles removes names (not paths) inside root.
func (c *Client) DeleteFiles(ctx context.Context, root string, names []string) error {
	if len(names) == 0 {
		return nil
	}
	return c.do(ctx, http.MethodPost, "/files/delete",
		map[string]any{"root": root, "files": names}, nil)
}

// ReadFile returns a file's contents as text.
func (c *Client) ReadFile(ctx context.Context, path string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.baseURL+"/api/client/servers/"+c.serverID+
			"/files/contents?file="+url.QueryEscape(path), nil)
	if err != nil {
		return "", fmt.Errorf("pterodactyl: build read request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("pterodactyl: read %s: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("pterodactyl: read %s: status %d: %s",
			path, resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("pterodactyl: read %s body: %w", path, err)
	}
	return string(b), nil
}

// WriteFile replaces a file's contents.
func (c *Client) WriteFile(ctx context.Context, path, content string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/api/client/servers/"+c.serverID+
			"/files/write?file="+url.QueryEscape(path), strings.NewReader(content))
	if err != nil {
		return fmt.Errorf("pterodactyl: build write request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "text/plain")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("pterodactyl: write %s: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("pterodactyl: write %s: status %d: %s",
			path, resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	return nil
}
