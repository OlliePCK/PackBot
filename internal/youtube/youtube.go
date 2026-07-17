// Package youtube is a minimal YouTube Data API v3 client covering what the
// bot needs: channel lookup by handle (/youtube command) and latest-video
// polling (notifications job). Built on net/http only — the API is plain
// JSON over GET, no client library required.
package youtube

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

const apiBase = "https://www.googleapis.com/youtube/v3"

// Client calls the YouTube Data API.
type Client struct {
	apiKey string
	http   *http.Client
}

// New builds a client. proxyURL is optional and only affects this client's
// requests (parity: Node proxied only YouTube polling).
func New(apiKey, proxyURL string) (*Client, error) {
	transport := &http.Transport{}
	if proxyURL != "" {
		parsed, err := url.Parse(proxyURL)
		if err != nil {
			return nil, fmt.Errorf("youtube: invalid PROXY_URL: %w", err)
		}
		transport.Proxy = http.ProxyURL(parsed)
	}
	return &Client{
		apiKey: apiKey,
		http:   &http.Client{Timeout: 15 * time.Second, Transport: transport},
	}, nil
}

// Channel is a YouTube channel with display stats.
type Channel struct {
	ID              string
	Title           string
	ThumbnailURL    string
	SubscriberCount string
	VideoCount      string
}

// Video is a channel's latest upload.
type Video struct {
	ID           string
	Title        string
	ChannelTitle string
	ThumbnailURL string
	PublishedAt  time.Time
}

type channelsResponse struct {
	Items []struct {
		ID      string `json:"id"`
		Snippet struct {
			Title      string `json:"title"`
			Thumbnails struct {
				High    struct{ URL string } `json:"high"`
				Default struct{ URL string } `json:"default"`
			} `json:"thumbnails"`
		} `json:"snippet"`
		Statistics struct {
			SubscriberCount string `json:"subscriberCount"`
			VideoCount      string `json:"videoCount"`
		} `json:"statistics"`
	} `json:"items"`
}

type searchResponse struct {
	Items []struct {
		ID struct {
			VideoID string `json:"videoId"`
		} `json:"id"`
		Snippet struct {
			Title        string `json:"title"`
			ChannelTitle string `json:"channelTitle"`
			PublishedAt  string `json:"publishedAt"`
			Thumbnails   struct {
				High    struct{ URL string } `json:"high"`
				Default struct{ URL string } `json:"default"`
			} `json:"thumbnails"`
		} `json:"snippet"`
	} `json:"items"`
}

func (c *Client) get(ctx context.Context, path string, params url.Values, out any) error {
	params.Set("key", c.apiKey)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiBase+path+"?"+params.Encode(), nil)
	if err != nil {
		return err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("youtube: %s returned HTTP %d", path, res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// ChannelByHandle resolves an @handle (or legacy username) to a channel.
// Returns nil when not found.
func (c *Client) ChannelByHandle(ctx context.Context, handle string) (*Channel, error) {
	lookups := []url.Values{
		{"part": {"snippet,statistics"}, "forHandle": {"@" + handle}},
		{"part": {"snippet,statistics"}, "forUsername": {handle}}, // legacy fallback
	}
	for _, params := range lookups {
		var res channelsResponse
		if err := c.get(ctx, "/channels", params, &res); err != nil {
			return nil, err
		}
		if len(res.Items) > 0 {
			item := res.Items[0]
			thumb := item.Snippet.Thumbnails.High.URL
			if thumb == "" {
				thumb = item.Snippet.Thumbnails.Default.URL
			}
			return &Channel{
				ID:              item.ID,
				Title:           item.Snippet.Title,
				ThumbnailURL:    thumb,
				SubscriberCount: item.Statistics.SubscriberCount,
				VideoCount:      item.Statistics.VideoCount,
			}, nil
		}
	}
	return nil, nil
}

// LatestVideo returns a channel's most recent upload (nil when none).
func (c *Client) LatestVideo(ctx context.Context, channelID string) (*Video, error) {
	var res searchResponse
	err := c.get(ctx, "/search", url.Values{
		"part":       {"snippet"},
		"channelId":  {channelID},
		"order":      {"date"},
		"type":       {"video"},
		"maxResults": {"1"},
	}, &res)
	if err != nil {
		return nil, err
	}
	if len(res.Items) == 0 || res.Items[0].ID.VideoID == "" {
		return nil, nil
	}
	item := res.Items[0]
	published, _ := time.Parse(time.RFC3339, item.Snippet.PublishedAt)
	thumb := item.Snippet.Thumbnails.High.URL
	if thumb == "" {
		thumb = item.Snippet.Thumbnails.Default.URL
	}
	return &Video{
		ID:           item.ID.VideoID,
		Title:        item.Snippet.Title,
		ChannelTitle: item.Snippet.ChannelTitle,
		ThumbnailURL: thumb,
		PublishedAt:  published,
	}, nil
}

// WatchURL returns the public watch link for a video ID.
func WatchURL(videoID string) string {
	return "https://www.youtube.com/watch?v=" + videoID
}
