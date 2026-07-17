package music

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/disgoorg/disgolink/v3/lavalink"
)

var (
	songNoiseRe    = regexp.MustCompile(`\(.*?\)|\[.*?\]`)
	songNonAlnumRe = regexp.MustCompile(`[^a-z0-9]+`)
)

// normalizeSongKey reduces a title/artist to a comparable key: lowercase,
// parenthetical noise and "- Topic" suffixes stripped, alphanumerics only.
// Used to stop autoplay picking the same song as a different upload.
func normalizeSongKey(s string) string {
	s = strings.ToLower(s)
	s = songNoiseRe.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "- topic", "")
	return songNonAlnumRe.ReplaceAllString(s, "")
}

// normalizeQueryWords lowercases and reduces to space-separated words —
// parenthesized content KEPT, unlike normalizeSongKey: in official titles
// like "Janice (STFU)" the parenthetical is part of the name.
func normalizeQueryWords(s string) string {
	s = strings.ToLower(s)
	s = songNonAlnumRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// Track is a queued item. Spotify tracks start lazy (SearchQuery set,
// Encoded nil) and are resolved to a Lavalink track just before playing —
// parity with the Node bot's lazy Track resolution.
type Track struct {
	Title      string
	Artist     string
	URL        string // playable URL (YouTube/SoundCloud); empty while lazy
	SpotifyURL string // display link for Spotify-sourced tracks
	Thumbnail  string
	Duration   time.Duration

	RequesterID string
	Requester   string // mention, used in embeds

	SearchQuery string          // lazy resolution query ("name artist")
	Explicit    bool            // from Spotify; guides clean-version rejection
	Encoded     *lavalink.Track // resolved Lavalink track
}

// DisplayURL prefers the playable URL, falling back to the Spotify link.
func (t *Track) DisplayURL() string {
	if t.URL != "" {
		return t.URL
	}
	return t.SpotifyURL
}

// FormattedDuration renders M:SS / H:MM:SS ("Unknown" when zero).
func (t *Track) FormattedDuration() string {
	if t.Duration <= 0 {
		return "Unknown"
	}
	total := int(t.Duration.Seconds())
	h, m, s := total/3600, (total%3600)/60, total%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%d:%02d", m, s)
}

// fromLavalink builds a resolved Track from a Lavalink track.
func fromLavalink(lt lavalink.Track, requesterID, requester string) *Track {
	t := &Track{
		Title:       lt.Info.Title,
		Artist:      lt.Info.Author,
		Duration:    time.Duration(lt.Info.Length) * time.Millisecond,
		RequesterID: requesterID,
		Requester:   requester,
		Encoded:     &lt,
	}
	if lt.Info.URI != nil {
		t.URL = *lt.Info.URI
	}
	if lt.Info.ArtworkURL != nil {
		t.Thumbnail = *lt.Info.ArtworkURL
	}
	return t
}

// RepeatMode mirrors the Node values: 0 off, 1 song, 2 queue.
type RepeatMode int

const (
	RepeatOff RepeatMode = iota
	RepeatSong
	RepeatQueue
)

func (m RepeatMode) String() string {
	switch m {
	case RepeatSong:
		return "Song"
	case RepeatQueue:
		return "Queue"
	default:
		return "Off"
	}
}

const historyLimit = 50
