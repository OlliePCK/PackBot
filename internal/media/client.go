package media

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxSessionsResponseBytes = 4 << 20

// JellyfinClient reads active Live TV sessions from Jellyfin. Its response
// model intentionally omits client, device, network, and remote-endpoint data.
type JellyfinClient struct {
	sessionsURL string
	token       string
	http        *http.Client
}

// NewJellyfinClient creates a client that authenticates with a Jellyfin API
// key using MediaBrowser token authentication.
func NewJellyfinClient(baseURL, token string) (*JellyfinClient, error) {
	return newJellyfinClient(baseURL, token, &http.Client{Timeout: 15 * time.Second})
}

func newJellyfinClient(baseURL, token string, httpClient *http.Client) (*JellyfinClient, error) {
	baseURL = strings.TrimSpace(baseURL)
	token = strings.TrimSpace(token)
	if baseURL == "" {
		return nil, fmt.Errorf("media: Jellyfin base URL is required")
	}
	if token == "" {
		return nil, fmt.Errorf("media: Jellyfin token is required")
	}
	if strings.ContainsAny(token, "\"\r\n") {
		return nil, fmt.Errorf("media: Jellyfin token contains invalid characters")
	}
	if httpClient == nil {
		return nil, fmt.Errorf("media: HTTP client is required")
	}

	u, err := url.Parse(baseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("media: invalid Jellyfin base URL")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("media: Jellyfin base URL must not contain credentials, query, or fragment")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/Sessions"

	return &JellyfinClient{
		sessionsURL: u.String(),
		token:       token,
		http:        httpClient,
	}, nil
}

// LiveTVSessions returns only the fields needed to reconcile Live TV cards.
// In particular, Jellyfin session IDs, IP addresses, device names, clients,
// and play-state details are neither decoded nor returned.
func (c *JellyfinClient) LiveTVSessions(ctx context.Context) ([]LiveTVSession, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.sessionsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("media: build Jellyfin sessions request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", `MediaBrowser Token="`+c.token+`"`)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("media: fetch Jellyfin sessions: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("media: fetch Jellyfin sessions: status %d", resp.StatusCode)
	}

	var rows []jellyfinSession
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSessionsResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("media: read Jellyfin sessions: %w", err)
	}
	if len(body) > maxSessionsResponseBytes {
		return nil, fmt.Errorf("media: Jellyfin sessions response exceeds size limit")
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, fmt.Errorf("media: decode Jellyfin sessions: %w", err)
	}
	if rows == nil {
		return nil, fmt.Errorf("media: decode Jellyfin sessions: expected an array")
	}

	sessions := make([]LiveTVSession, 0, len(rows))
	for index, row := range rows {
		item := row.NowPlayingItem
		if item == nil {
			continue
		}

		channelID := canonicalJellyfinID(item.ChannelID)
		channelName := cleanText(item.ChannelName)
		programID := strings.TrimSpace(item.ID)
		programName := cleanText(item.Name)
		itemType := strings.TrimSpace(item.Type)
		channelItem := strings.EqualFold(itemType, "TvChannel") ||
			strings.EqualFold(itemType, "LiveTvChannel")
		liveTVSignal := item.IsLive || channelItem ||
			channelID != "" || channelName != ""
		if !liveTVSignal {
			continue
		}

		if channelItem {
			itemChannelID := canonicalJellyfinID(programID)
			if channelID != "" && itemChannelID != "" && channelID != itemChannelID {
				return nil, fmt.Errorf(
					"media: ambiguous active Live TV session %d: conflicting channel IDs",
					index,
				)
			}
			if channelID == "" {
				channelID = itemChannelID
			}
			if channelName == "" {
				channelName = programName
			}
			programID = ""
			programName = ""
		}
		if channelID == "" {
			return nil, fmt.Errorf(
				"media: ambiguous active Live TV session %d: channel identity is missing",
				index,
			)
		}

		sessions = append(sessions, LiveTVSession{
			ViewerID:    canonicalJellyfinID(row.UserID),
			ChannelID:   channelID,
			ChannelName: channelName,
			ProgramID:   programID,
			ProgramName: programName,
		})
	}
	return sessions, nil
}

// jellyfinSession is deliberately narrower than Jellyfin's SessionInfoDto.
// Sensitive fields in the response are ignored by encoding/json.
type jellyfinSession struct {
	UserID         string            `json:"UserId"`
	NowPlayingItem *jellyfinLiveItem `json:"NowPlayingItem"`
}

type jellyfinLiveItem struct {
	ID          string `json:"Id"`
	Name        string `json:"Name"`
	Type        string `json:"Type"`
	ChannelID   string `json:"ChannelId"`
	ChannelName string `json:"ChannelName"`
	IsLive      bool   `json:"IsLive"`
}
