// Package spotify is a minimal Spotify Web API client for resolving track,
// album and playlist metadata (client-credentials flow). Playback never
// touches Spotify — tracks are matched to YouTube by the music package.
package spotify

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	tokenURL = "https://accounts.spotify.com/api/token"
	apiBase  = "https://api.spotify.com/v1"
)

// Client calls the Spotify Web API with an auto-refreshed app token.
type Client struct {
	id, secret string
	http       *http.Client

	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

// New builds a client (credentials from SPOTIFY_CLIENT_ID/SECRET).
func New(id, secret string) *Client {
	return &Client{id: id, secret: secret, http: &http.Client{Timeout: 15 * time.Second}}
}

// Track is the resolved metadata the music system needs.
type Track struct {
	Name      string
	Artist    string
	AlbumName string
	Thumbnail string
	URL       string
	Duration  time.Duration
	Explicit  bool
}

// Playlist bundles playlist display info with its tracks.
type Playlist struct {
	Name      string
	URL       string
	Thumbnail string
	Tracks    []Track
}

var spotifyURLRe = regexp.MustCompile(`spotify\.com/(track|playlist|album)/([A-Za-z0-9]+)`)

// ParseURL extracts the resource kind and ID from a Spotify URL
// ("" kind when it isn't one).
func ParseURL(raw string) (kind, id string) {
	m := spotifyURLRe.FindStringSubmatch(raw)
	if m == nil {
		return "", ""
	}
	return m[1], m[2]
}

func (c *Client) ensureToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Now().Before(c.expiresAt) {
		return c.token, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL,
		strings.NewReader("grant_type=client_credentials"))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(c.id+":"+c.secret)))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	res, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("spotify: token request: %w", err)
	}
	defer res.Body.Close()

	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil || body.AccessToken == "" {
		return "", fmt.Errorf("spotify: token response invalid (HTTP %d)", res.StatusCode)
	}
	c.token = body.AccessToken
	// Refresh a minute early (parity with the Node client).
	c.expiresAt = time.Now().Add(time.Duration(body.ExpiresIn)*time.Second - time.Minute)
	return c.token, nil
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	token, err := c.ensureToken(ctx)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiBase+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("spotify: %s returned HTTP %d", path, res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

type apiTrack struct {
	Name    string `json:"name"`
	Artists []struct {
		Name string `json:"name"`
	} `json:"artists"`
	Album struct {
		Name   string `json:"name"`
		Images []struct {
			URL string `json:"url"`
		} `json:"images"`
	} `json:"album"`
	DurationMs   int  `json:"duration_ms"`
	Explicit     bool `json:"explicit"`
	ExternalURLs struct {
		Spotify string `json:"spotify"`
	} `json:"external_urls"`
}

func (t apiTrack) toTrack() Track {
	track := Track{
		Name:      t.Name,
		AlbumName: t.Album.Name,
		URL:       t.ExternalURLs.Spotify,
		Duration:  time.Duration(t.DurationMs) * time.Millisecond,
		Explicit:  t.Explicit,
	}
	if len(t.Artists) > 0 {
		track.Artist = t.Artists[0].Name
	}
	if len(t.Album.Images) > 0 {
		track.Thumbnail = t.Album.Images[0].URL
	}
	return track
}

// GetTrack fetches one track's metadata.
func (c *Client) GetTrack(ctx context.Context, id string) (*Track, error) {
	var raw apiTrack
	if err := c.get(ctx, "/tracks/"+url.PathEscape(id), &raw); err != nil {
		return nil, err
	}
	track := raw.toTrack()
	return &track, nil
}

// SearchTrack returns Spotify's best track match for a text query (nil when
// none). Used to enrich plaintext /play searches with canonical duration and
// the explicit flag.
func (c *Client) SearchTrack(ctx context.Context, query string) (*Track, error) {
	var res struct {
		Tracks struct {
			Items []apiTrack `json:"items"`
		} `json:"tracks"`
	}
	path := "/search?type=track&limit=1&q=" + url.QueryEscape(query)
	if err := c.get(ctx, path, &res); err != nil {
		return nil, err
	}
	if len(res.Tracks.Items) == 0 {
		return nil, nil
	}
	track := res.Tracks.Items[0].toTrack()
	return &track, nil
}

// GetPlaylist fetches playlist info and all its tracks (paged by 100).
func (c *Client) GetPlaylist(ctx context.Context, id string) (*Playlist, error) {
	var info struct {
		Name   string `json:"name"`
		Images []struct {
			URL string `json:"url"`
		} `json:"images"`
		ExternalURLs struct {
			Spotify string `json:"spotify"`
		} `json:"external_urls"`
		Tracks struct {
			Total int `json:"total"`
		} `json:"tracks"`
	}
	if err := c.get(ctx, "/playlists/"+url.PathEscape(id)+"?fields=name,images,external_urls,tracks.total", &info); err != nil {
		return nil, err
	}

	playlist := &Playlist{Name: info.Name, URL: info.ExternalURLs.Spotify}
	if len(info.Images) > 0 {
		playlist.Thumbnail = info.Images[0].URL
	}

	for offset := 0; offset < info.Tracks.Total; offset += 100 {
		var page struct {
			Items []struct {
				Track *apiTrack `json:"track"`
			} `json:"items"`
		}
		path := fmt.Sprintf("/playlists/%s/tracks?offset=%d&limit=100&fields=items(track(name,artists,album(name,images),duration_ms,explicit,external_urls))",
			url.PathEscape(id), offset)
		if err := c.get(ctx, path, &page); err != nil {
			return nil, err
		}
		for _, item := range page.Items {
			if item.Track == nil || item.Track.Name == "" {
				continue
			}
			playlist.Tracks = append(playlist.Tracks, item.Track.toTrack())
		}
		if len(page.Items) == 0 {
			break
		}
	}
	return playlist, nil
}

// GetAlbum fetches album info and its tracks.
func (c *Client) GetAlbum(ctx context.Context, id string) (*Playlist, error) {
	var raw struct {
		Name   string `json:"name"`
		Images []struct {
			URL string `json:"url"`
		} `json:"images"`
		ExternalURLs struct {
			Spotify string `json:"spotify"`
		} `json:"external_urls"`
		Tracks struct {
			Items []struct {
				Name    string `json:"name"`
				Artists []struct {
					Name string `json:"name"`
				} `json:"artists"`
				DurationMs   int  `json:"duration_ms"`
				Explicit     bool `json:"explicit"`
				ExternalURLs struct {
					Spotify string `json:"spotify"`
				} `json:"external_urls"`
			} `json:"items"`
		} `json:"tracks"`
	}
	if err := c.get(ctx, "/albums/"+url.PathEscape(id), &raw); err != nil {
		return nil, err
	}

	album := &Playlist{Name: raw.Name, URL: raw.ExternalURLs.Spotify}
	var thumb string
	if len(raw.Images) > 0 {
		thumb = raw.Images[0].URL
		album.Thumbnail = thumb
	}
	for _, t := range raw.Tracks.Items {
		track := Track{
			Name: t.Name, AlbumName: raw.Name, Thumbnail: thumb,
			URL:      t.ExternalURLs.Spotify,
			Duration: time.Duration(t.DurationMs) * time.Millisecond,
			Explicit: t.Explicit,
		}
		if len(t.Artists) > 0 {
			track.Artist = t.Artists[0].Name
		}
		album.Tracks = append(album.Tracks, track)
	}
	return album, nil
}
