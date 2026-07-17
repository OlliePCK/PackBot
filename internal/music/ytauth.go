// YouTube OAuth upkeep. youtube-source's refresh token (a burner Google
// account) is the one credential in the stack that can silently die — Google
// can revoke it or flag the account. When that happens every YouTube play
// fails with a login-wall error, so the bot (a) DMs the admin the recovery
// steps, and (b) accepts a replacement token over DM (/ytauth), pushing it
// into the running Lavalink node via the plugin's POST /youtube route — no
// container restart needed.

package music

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/style"
)

// authFailureRe matches the login-wall messages youtube-source raises when
// its OAuth token is dead ("This video requires login.", "Please sign in",
// "Sign in to confirm you're not a bot").
var authFailureRe = regexp.MustCompile(`(?i)requires login|sign ?in|login[ _-]?required`)

// authAlertInterval debounces the admin DM: one alert per window, not one
// per failed track.
const authAlertInterval = 12 * time.Hour

// maybeNotifyAuthFailure DMs the admin the re-link steps when a track
// exception looks like a YouTube login wall.
func (m *Manager) maybeNotifyAuthFailure(message string) {
	if m.adminUserID == "" || !authFailureRe.MatchString(message) {
		return
	}
	m.authMu.Lock()
	recent := time.Since(m.lastAuthAlert) < authAlertInterval
	if !recent {
		m.lastAuthAlert = time.Now()
	}
	m.authMu.Unlock()
	if recent {
		return
	}

	channel, err := m.session.UserChannelCreate(m.adminUserID)
	if err != nil {
		m.log.Error("cannot open admin DM for YouTube auth alert", "error", err)
		return
	}
	embed := &discordgo.MessageEmbed{
		Title: "⚠️ YouTube authentication is failing",
		Description: fmt.Sprintf(
			"Lavalink reported a login-wall error from YouTube:\n> %s\n\n"+
				"The OAuth refresh token has likely expired or been revoked. "+
				"YouTube playback will keep failing until it's re-linked.", message),
		Color: style.ColorWarn,
		Fields: []*discordgo.MessageEmbedField{
			{
				Name: "Option A — re-link on grid",
				Value: "1. Edit `/mnt/user/appdata/packbot-lavalink/application.yml`: comment out " +
					"`refreshToken` and `skipInitialization` under `plugins.youtube.oauth`, then " +
					"`docker restart PackBot-Lavalink`.\n" +
					"2. `docker logs -f PackBot-Lavalink` prints a code — open " +
					"<https://www.google.com/device>, enter it, sign in with the **burner** account " +
					"(never a personal one).\n" +
					"3. The log then prints the new refresh token — pin it back into " +
					"`application.yml` and restore `skipInitialization: true`.",
			},
			{
				Name: "Option B — mint elsewhere, submit by DM",
				Value: "Run the repo's `lavalink/` container locally with `refreshToken` commented " +
					"out, link via the logged device code as above, copy the token from the log, " +
					"then DM me:\n`/ytauth set token:<the token>`\n" +
					"It's pushed into grid's Lavalink instantly (no restart). Still pin it into " +
					"grid's `application.yml` afterwards so it survives Lavalink restarts.",
			},
			{
				Name:  "Check state",
				Value: "`/ytauth status` shows whether a token is currently loaded.",
			},
		},
		Footer: style.Footer(),
	}
	if _, err := m.session.ChannelMessageSendEmbed(channel.ID, embed); err != nil {
		m.log.Error("failed to send YouTube auth alert DM", "error", err)
		return
	}
	m.log.Warn("YouTube auth failure detected; admin alerted by DM", "message", message)
}

// SetYouTubeRefreshToken pushes a new OAuth refresh token into the running
// Lavalink node (youtube-source's POST /youtube). It takes effect
// immediately; surviving a Lavalink restart still requires pinning the token
// in the node's application.yml.
func (m *Manager) SetYouTubeRefreshToken(ctx context.Context, token string) error {
	payload, err := json.Marshal(map[string]any{
		"refreshToken":       token,
		"skipInitialization": true,
	})
	if err != nil {
		return err
	}
	status, body, err := m.nodeRequest(ctx, http.MethodPost, "/youtube", payload)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("music: lavalink POST /youtube: status %d: %s", status, body)
	}

	// Re-arm the alert: if this token is also bad, the next login wall should
	// notify straight away instead of waiting out the debounce window.
	m.authMu.Lock()
	m.lastAuthAlert = time.Time{}
	m.authMu.Unlock()
	m.log.Info("youtube oauth refresh token updated on lavalink node")
	return nil
}

// YouTubeRefreshToken reports the refresh token currently loaded on the node
// (GET /youtube), or "" when OAuth is inactive.
func (m *Manager) YouTubeRefreshToken(ctx context.Context) (string, error) {
	status, body, err := m.nodeRequest(ctx, http.MethodGet, "/youtube", nil)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("music: lavalink GET /youtube: status %d: %s", status, body)
	}
	var out struct {
		RefreshToken *string `json:"refreshToken"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("music: lavalink GET /youtube: %w", err)
	}
	if out.RefreshToken == nil {
		return "", nil
	}
	return *out.RefreshToken, nil
}

// nodeRequest performs an authenticated HTTP call against the Lavalink node
// and returns the status and full response body (plugin routes live outside
// disgolink's REST client, so this goes direct).
func (m *Manager) nodeRequest(ctx context.Context, method, path string, payload []byte) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var reqBody io.Reader
	if payload != nil {
		reqBody = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://"+m.nodeAddress+path, reqBody)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", m.nodePassword)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("music: lavalink %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return 0, nil, fmt.Errorf("music: lavalink %s %s: read body: %w", method, path, err)
	}
	return resp.StatusCode, body, nil
}
