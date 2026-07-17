package music

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/disgoorg/disgolink/v3/disgolink"
	"github.com/disgoorg/disgolink/v3/lavalink"

	"github.com/OlliePCK/packbot/internal/spotify"
	"github.com/OlliePCK/packbot/internal/youtube"
)

// queryModifierRe marks searches for a specific variant (slowed, remix, …).
// Such queries skip Spotify enrichment: the user wants that variant, not the
// canonical track the enrichment would gate towards.
var queryModifierRe = regexp.MustCompile(`(?i)\b(slowed|reverb|sped|speed\s*up|nightcore|daycore|remix|cover|live|acoustic|instrumental|karaoke|8d|mashup|bootleg|edit|clean|lyrics?)\b`)

// PlaylistInfo describes a resolved playlist/album for the "Playlist added"
// embed.
type PlaylistInfo struct {
	Title     string
	URL       string
	Thumbnail string
	Count     int
}

// Resolve turns a /play query into tracks:
//   - Spotify URLs → Spotify metadata → lazy tracks (YouTube-matched later)
//   - other URLs → Lavalink loadtracks (YouTube video/playlist, SoundCloud…)
//   - plain text → scored YouTube search (Data API) or ytsearch fallback
func (m *Manager) Resolve(ctx context.Context, query, requesterID, requester string) ([]*Track, *PlaylistInfo, error) {
	query = strings.TrimSpace(query)

	if kind, id := spotify.ParseURL(query); kind != "" {
		return m.resolveSpotify(ctx, kind, id, requesterID, requester)
	}

	if isURL(query) {
		return m.resolveLavalinkURL(ctx, query, requesterID, requester)
	}

	// Plaintext search: enrich with Spotify's canonical duration + explicit
	// flag when the query isn't asking for a specific variant. Without this,
	// text searches fly blind and clean radio versions win (live-testing
	// regression: "janice stfu" resolved clean).
	//
	// The match must actually cover the query's terms: Spotify search always
	// returns its closest guess, and for YouTube-only songs an unrelated
	// "match" would poison the duration gate. The bot never plays the
	// Spotify result itself — enrichment only supplies metadata.
	var expected time.Duration
	explicit := false
	if m.spotify != nil && !queryModifierRe.MatchString(query) {
		if st, err := m.spotify.SearchTrack(ctx, query); err != nil {
			m.log.Warn("spotify enrichment failed", "error", err)
		} else if st != nil && queryMatchesTrack(query, st.Name, st.Artist) {
			expected = st.Duration
			explicit = st.Explicit
			m.log.Debug("spotify enrichment", "query", query, "match", st.Name, "explicit", st.Explicit)
		} else if st != nil {
			m.log.Debug("spotify enrichment discarded (weak match)", "query", query, "match", st.Name)
		}
	}

	track, err := m.searchTrack(ctx, query, expected, explicit)
	if err != nil {
		return nil, nil, err
	}
	if track == nil {
		return nil, nil, nil
	}
	track.RequesterID = requesterID
	track.Requester = requester
	return []*Track{track}, nil, nil
}

func (m *Manager) resolveSpotify(ctx context.Context, kind, id, requesterID, requester string) ([]*Track, *PlaylistInfo, error) {
	if m.spotify == nil {
		return nil, nil, fmt.Errorf("spotify is not configured")
	}

	lazy := func(st spotify.Track) *Track {
		return &Track{
			Title:       st.Name,
			Artist:      st.Artist,
			SpotifyURL:  st.URL,
			Thumbnail:   st.Thumbnail,
			Duration:    st.Duration,
			RequesterID: requesterID,
			Requester:   requester,
			// Name + artist only: album names pollute search results
			// (learned from live testing; Node included the album).
			SearchQuery: strings.TrimSpace(st.Name + " " + st.Artist),
			Explicit:    st.Explicit,
		}
	}

	switch kind {
	case "track":
		st, err := m.spotify.GetTrack(ctx, id)
		if err != nil {
			return nil, nil, err
		}
		return []*Track{lazy(*st)}, nil, nil

	case "playlist", "album":
		var (
			pl  *spotify.Playlist
			err error
		)
		if kind == "playlist" {
			pl, err = m.spotify.GetPlaylist(ctx, id)
		} else {
			pl, err = m.spotify.GetAlbum(ctx, id)
		}
		if err != nil {
			return nil, nil, err
		}
		tracks := make([]*Track, 0, len(pl.Tracks))
		for _, st := range pl.Tracks {
			tracks = append(tracks, lazy(st))
		}
		info := &PlaylistInfo{Title: pl.Name, URL: pl.URL, Thumbnail: pl.Thumbnail, Count: len(tracks)}
		return tracks, info, nil
	}
	return nil, nil, fmt.Errorf("unsupported spotify URL")
}

func (m *Manager) resolveLavalinkURL(ctx context.Context, query, requesterID, requester string) ([]*Track, *PlaylistInfo, error) {
	var (
		tracks  []*Track
		info    *PlaylistInfo
		loadErr error
	)
	done := make(chan struct{})
	m.client.BestNode().LoadTracksHandler(ctx, query, disgolink.NewResultHandler(
		func(t lavalink.Track) {
			tracks = []*Track{fromLavalink(t, requesterID, requester)}
			close(done)
		},
		func(playlist lavalink.Playlist) {
			for _, t := range playlist.Tracks {
				tracks = append(tracks, fromLavalink(t, requesterID, requester))
			}
			info = &PlaylistInfo{Title: playlist.Info.Name, URL: query, Count: len(tracks)}
			if len(tracks) > 0 {
				info.Thumbnail = tracks[0].Thumbnail
			}
			close(done)
		},
		func(results []lavalink.Track) {
			if len(results) > 0 {
				tracks = []*Track{fromLavalink(results[0], requesterID, requester)}
			}
			close(done)
		},
		func() { close(done) },
		func(err error) { loadErr = err; close(done) },
	))
	select {
	case <-done:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}
	return tracks, info, loadErr
}

// queryMatchesTrack reports whether a Spotify search result plausibly IS the
// song the user typed: at least 70% of the query's significant terms must
// appear in the track's name+artist (normalized, accent-insensitive).
func queryMatchesTrack(query, name, artist string) bool {
	haystack := normalizeQueryWords(name + " " + artist)
	terms := strings.Fields(normalizeQueryWords(query))
	if len(terms) == 0 {
		return false
	}
	matched := 0
	for _, term := range terms {
		if strings.Contains(haystack, term) {
			matched++
		}
	}
	return float64(matched)/float64(len(terms)) >= 0.7
}

// durationClose reports whether two durations are within 15s (the wrong-match
// threshold from the Node bot).
func durationClose(a, b time.Duration) bool {
	diff := a - b
	if diff < 0 {
		diff = -diff
	}
	return diff <= 15*time.Second
}

// searchTrack finds the best YouTube track for a text query.
//
// Strategy (refined over live-testing rounds):
//  1. With an expected duration: YouTube Music search — ytmsearch returns
//     official audio almost exclusively. Candidates must be within ±15s of
//     the expected duration, never fan edits, and when the source track is
//     explicit, never marked clean (YT Music lists clean variants at the
//     same duration, so title marking is the only distinguishing signal).
//  2. Scored Data API pipeline (candidate scoring, fan-edit penalties).
//  3. Plain ytsearch first-result fallback.
func (m *Manager) searchTrack(ctx context.Context, query string, expected time.Duration, explicit bool) (*Track, error) {
	if expected > 0 {
		results, err := m.lavalinkSearchAll(ctx, lavalink.SearchTypeYouTubeMusic.Apply(query))
		if err != nil {
			m.log.Warn("ytmsearch failed", "error", err)
		}
		for idx, lt := range results {
			if idx >= 5 {
				break
			}
			if !durationClose(time.Duration(lt.Info.Length)*time.Millisecond, expected) {
				continue
			}
			if youtube.LooksFanEdit(lt.Info.Title) {
				continue
			}
			if explicit && youtube.LooksClean(lt.Info.Title) {
				continue
			}
			return fromLavalink(lt, "", ""), nil
		}
	}

	if m.yt != nil {
		candidate, err := m.yt.BestMatch(ctx, query, expected)
		if err != nil {
			m.log.Warn("scored search failed; falling back to ytsearch", "error", err)
		} else if candidate != nil {
			lt, err := m.lavalinkSearch(ctx, "https://www.youtube.com/watch?v="+candidate.ID)
			if err == nil && lt != nil {
				return fromLavalink(*lt, "", ""), nil
			}
			m.log.Warn("lavalink load of scored match failed; falling back to ytsearch", "video", candidate.ID, "error", err)
		}
	}

	lt, err := m.lavalinkSearch(ctx, lavalink.SearchTypeYouTube.Apply(query))
	if err != nil || lt == nil {
		return nil, err
	}
	return fromLavalink(*lt, "", ""), nil
}

// lavalinkSearchAll returns all results for a search identifier.
func (m *Manager) lavalinkSearchAll(ctx context.Context, identifier string) ([]lavalink.Track, error) {
	var (
		tracks  []lavalink.Track
		loadErr error
	)
	done := make(chan struct{})
	m.client.BestNode().LoadTracksHandler(ctx, identifier, disgolink.NewResultHandler(
		func(t lavalink.Track) { tracks = []lavalink.Track{t}; close(done) },
		func(playlist lavalink.Playlist) { tracks = playlist.Tracks; close(done) },
		func(results []lavalink.Track) { tracks = results; close(done) },
		func() { close(done) },
		func(err error) { loadErr = err; close(done) },
	))
	select {
	case <-done:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return tracks, loadErr
}

// lavalinkSearch loads one track for an identifier (first result for
// searches/playlists).
func (m *Manager) lavalinkSearch(ctx context.Context, identifier string) (*lavalink.Track, error) {
	var (
		track   *lavalink.Track
		loadErr error
	)
	done := make(chan struct{})
	m.client.BestNode().LoadTracksHandler(ctx, identifier, disgolink.NewResultHandler(
		func(t lavalink.Track) { track = &t; close(done) },
		func(playlist lavalink.Playlist) {
			if len(playlist.Tracks) > 0 {
				track = &playlist.Tracks[0]
			}
			close(done)
		},
		func(results []lavalink.Track) {
			if len(results) > 0 {
				track = &results[0]
			}
			close(done)
		},
		func() { close(done) },
		func(err error) { loadErr = err; close(done) },
	))
	select {
	case <-done:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return track, loadErr
}

// resolveTrack fills Encoded for lazy (Spotify) tracks via the scored search.
func (m *Manager) resolveTrack(ctx context.Context, t *Track) error {
	if t.Encoded != nil {
		return nil
	}
	if t.SearchQuery == "" {
		return fmt.Errorf("track has no search query")
	}

	resolved, err := m.searchTrack(ctx, t.SearchQuery, t.Duration, t.Explicit)
	if err != nil {
		return err
	}
	if resolved == nil {
		return fmt.Errorf("no results for %q", t.SearchQuery)
	}

	// Duration mismatch warning (memory: possible wrong match signal).
	if t.Duration > 0 && resolved.Duration > 0 {
		diff := t.Duration - resolved.Duration
		if diff < 0 {
			diff = -diff
		}
		if diff > 15*time.Second {
			m.log.Warn("duration mismatch — possible wrong match",
				"title", t.Title, "spotify", t.Duration, "youtube", resolved.Duration)
		}
	}

	t.Encoded = resolved.Encoded
	t.URL = resolved.URL
	if t.Duration == 0 {
		t.Duration = resolved.Duration
	}
	if t.Thumbnail == "" {
		t.Thumbnail = resolved.Thumbnail
	}
	return nil
}

func isURL(s string) bool {
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}
