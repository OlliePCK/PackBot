// Package youtube is a minimal YouTube Data API v3 client covering what the
// bot needs: channel lookup by handle (/youtube command) and latest-video
// polling (notifications job). Built on net/http only — the API is plain
// JSON over GET, no client library required.
package youtube

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

const apiBase = "https://www.googleapis.com/youtube/v3"

// Client calls the YouTube Data API.
type Client struct {
	apiKey  string
	http    *http.Client
	baseURL string

	uploadsPlaylists sync.Map // channel ID -> uploads playlist ID
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
		apiKey:  apiKey,
		http:    &http.Client{Timeout: 15 * time.Second, Transport: transport},
		baseURL: apiBase,
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
		ContentDetails struct {
			RelatedPlaylists struct {
				Uploads string `json:"uploads"`
			} `json:"relatedPlaylists"`
		} `json:"contentDetails"`
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
	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = apiBase
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+path+"?"+params.Encode(), nil)
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
		{"part": {"snippet,statistics,contentDetails"}, "forHandle": {"@" + handle}},
		{"part": {"snippet,statistics,contentDetails"}, "forUsername": {handle}}, // legacy fallback
	}
	for _, params := range lookups {
		var res channelsResponse
		if err := c.get(ctx, "/channels", params, &res); err != nil {
			return nil, err
		}
		if len(res.Items) > 0 {
			item := res.Items[0]
			if playlistID := item.ContentDetails.RelatedPlaylists.Uploads; playlistID != "" {
				c.uploadsPlaylists.Store(item.ID, playlistID)
			}
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

// RecentUploads returns the newest public videos from the channel's canonical
// uploads playlist. Unlike search results, this playlist is the API resource
// YouTube exposes specifically for a channel's uploaded videos.
func (c *Client) RecentUploads(ctx context.Context, channelID string, limit int) ([]Video, error) {
	if limit < 1 {
		limit = 1
	}
	if limit > 50 {
		limit = 50
	}

	playlistID, err := c.uploadsPlaylist(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if playlistID == "" {
		return nil, nil
	}

	var res struct {
		Items []struct {
			Snippet struct {
				Title        string `json:"title"`
				ChannelTitle string `json:"channelTitle"`
				PublishedAt  string `json:"publishedAt"`
				ResourceID   struct {
					VideoID string `json:"videoId"`
				} `json:"resourceId"`
				Thumbnails struct {
					High    struct{ URL string } `json:"high"`
					Default struct{ URL string } `json:"default"`
				} `json:"thumbnails"`
			} `json:"snippet"`
			ContentDetails struct {
				VideoID          string `json:"videoId"`
				VideoPublishedAt string `json:"videoPublishedAt"`
			} `json:"contentDetails"`
		} `json:"items"`
	}
	err = c.get(ctx, "/playlistItems", url.Values{
		"part":       {"snippet,contentDetails"},
		"playlistId": {playlistID},
		"maxResults": {strconv.Itoa(limit)},
	}, &res)
	if err != nil {
		return nil, err
	}

	videos := make([]Video, 0, len(res.Items))
	for _, item := range res.Items {
		videoID := item.ContentDetails.VideoID
		if videoID == "" {
			videoID = item.Snippet.ResourceID.VideoID
		}
		if videoID == "" {
			continue
		}
		publishedText := item.ContentDetails.VideoPublishedAt
		if publishedText == "" {
			publishedText = item.Snippet.PublishedAt
		}
		published, _ := time.Parse(time.RFC3339, publishedText)
		thumb := item.Snippet.Thumbnails.High.URL
		if thumb == "" {
			thumb = item.Snippet.Thumbnails.Default.URL
		}
		videos = append(videos, Video{
			ID:           videoID,
			Title:        html.UnescapeString(item.Snippet.Title),
			ChannelTitle: html.UnescapeString(item.Snippet.ChannelTitle),
			ThumbnailURL: thumb,
			PublishedAt:  published,
		})
	}
	return videos, nil
}

func (c *Client) uploadsPlaylist(ctx context.Context, channelID string) (string, error) {
	if cached, ok := c.uploadsPlaylists.Load(channelID); ok {
		return cached.(string), nil
	}
	var res channelsResponse
	if err := c.get(ctx, "/channels", url.Values{
		"part": {"contentDetails"},
		"id":   {channelID},
	}, &res); err != nil {
		return "", err
	}
	if len(res.Items) == 0 {
		return "", nil
	}
	playlistID := res.Items[0].ContentDetails.RelatedPlaylists.Uploads
	if playlistID != "" {
		c.uploadsPlaylists.Store(channelID, playlistID)
	}
	return playlistID, nil
}

// WatchURL returns the public watch link for a video ID.
func WatchURL(videoID string) string {
	return "https://www.youtube.com/watch?v=" + videoID
}
