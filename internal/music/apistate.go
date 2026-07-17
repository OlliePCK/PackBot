package music

import (
	"context"
	"sync"
)

// Web-API integration: state snapshots shaped like the Node WebAPI payloads,
// and update notifications that drive the realtime WebSocket.

// APIQueueItem is one queue entry in API payloads.
type APIQueueItem struct {
	Position    int    `json:"position"`
	Title       string `json:"title"`
	Artist      string `json:"artist"`
	Duration    int    `json:"duration"`
	Thumbnail   string `json:"thumbnail"`
	RequestedBy string `json:"requestedBy"`
}

// APITrack is the current track in API payloads.
type APITrack struct {
	Title       string `json:"title"`
	Artist      string `json:"artist"`
	URL         string `json:"url"`
	Thumbnail   string `json:"thumbnail"`
	Duration    int    `json:"duration"`
	Progress    int    `json:"progress"`
	RequestedBy string `json:"requestedBy"`
}

// NowPlayingState is the full player state payload (REST /nowplaying and the
// WS "nowplaying" event share it — key names match the Node bot's).
type NowPlayingState struct {
	Playing     bool           `json:"playing"`
	Paused      bool           `json:"paused"`
	Track       *APITrack      `json:"track"`
	Queue       []APIQueueItem `json:"queue"`
	QueueLength int            `json:"queueLength"`
	Volume      int            `json:"volume"`
	RepeatMode  int            `json:"repeatMode"`
	Autoplay    bool           `json:"autoplay"`
	Filters     []string       `json:"filters"`
	HasPrevious bool           `json:"hasPrevious"`
	HasNext     bool           `json:"hasNext"`
}

// listenerRegistry fans update notifications out to the API layer.
type listenerRegistry struct {
	mu        sync.Mutex
	listeners []func(guildID string)
}

// OnUpdate registers a callback fired whenever a guild's player state
// changes (track start/end, queue mutations, volume, filters, …).
func (m *Manager) OnUpdate(fn func(guildID string)) {
	m.updates.mu.Lock()
	m.updates.listeners = append(m.updates.listeners, fn)
	m.updates.mu.Unlock()
}

func (m *Manager) notifyUpdate(guildID string) {
	m.updates.mu.Lock()
	listeners := make([]func(guildID string), len(m.updates.listeners))
	copy(listeners, m.updates.listeners)
	m.updates.mu.Unlock()
	for _, fn := range listeners {
		go fn(guildID)
	}
}

// requesterName resolves a display name for API payloads.
func (m *Manager) requesterName(guildID string, t *Track) string {
	if t == nil || t.RequesterID == "" {
		return "Unknown"
	}
	if member, err := m.session.State.Member(guildID, t.RequesterID); err == nil && member.User != nil {
		return member.User.Username
	}
	return "Unknown"
}

// APIState builds the full player state for a guild.
func (m *Manager) APIState(guildID string, queueLimit int) NowPlayingState {
	gp := m.Guild(guildID)
	snapshot := gp.Snapshot()

	state := NowPlayingState{
		Playing:     snapshot.Current != nil,
		Paused:      m.Paused(guildID),
		Queue:       []APIQueueItem{},
		QueueLength: len(snapshot.Queue),
		Volume:      snapshot.Volume,
		RepeatMode:  int(snapshot.RepeatMode),
		Autoplay:    snapshot.Autoplay,
		Filters:     m.ActiveFilters(guildID),
		HasPrevious: snapshot.HistoryLen > 0,
		HasNext:     len(snapshot.Queue) > 0,
	}
	if state.Filters == nil {
		state.Filters = []string{}
	}

	if snapshot.Current != nil {
		t := snapshot.Current
		state.Track = &APITrack{
			Title:       t.Title,
			Artist:      t.Artist,
			URL:         t.DisplayURL(),
			Thumbnail:   t.Thumbnail,
			Duration:    int(t.Duration.Seconds()),
			Progress:    int(m.Position(guildID).Seconds()),
			RequestedBy: m.requesterName(guildID, t),
		}
	}

	limit := min(queueLimit, len(snapshot.Queue))
	for idx := 0; idx < limit; idx++ {
		t := snapshot.Queue[idx]
		state.Queue = append(state.Queue, APIQueueItem{
			Position:    idx + 1,
			Title:       t.Title,
			Artist:      t.Artist,
			Duration:    int(t.Duration.Seconds()),
			Thumbnail:   t.Thumbnail,
			RequestedBy: m.requesterName(guildID, t),
		})
	}
	return state
}

// FullQueue returns all queued tracks as API items plus the current track.
func (m *Manager) FullQueue(guildID string) (current *APITrack, items []APIQueueItem) {
	gp := m.Guild(guildID)
	snapshot := gp.Snapshot()
	if snapshot.Current != nil {
		t := snapshot.Current
		current = &APITrack{
			Title: t.Title, Artist: t.Artist, URL: t.DisplayURL(),
			Thumbnail: t.Thumbnail, Duration: int(t.Duration.Seconds()),
			Progress:    int(m.Position(guildID).Seconds()),
			RequestedBy: m.requesterName(guildID, t),
		}
	}
	items = []APIQueueItem{}
	for idx, t := range snapshot.Queue {
		items = append(items, APIQueueItem{
			Position: idx + 1, Title: t.Title, Artist: t.Artist,
			Duration: int(t.Duration.Seconds()), Thumbnail: t.Thumbnail,
			RequestedBy: m.requesterName(guildID, t),
		})
	}
	return current, items
}

// InVoice reports whether the bot has an active voice session for the guild
// (the Node API's "active music session" precondition).
func (m *Manager) InVoice(guildID string) bool {
	gp := m.Guild(guildID)
	gp.mu.Lock()
	defer gp.mu.Unlock()
	return gp.VoiceChannelID != ""
}

// ActiveVoiceCount counts guilds with a live voice session (/api/stats).
func (m *Manager) ActiveVoiceCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, gp := range m.guilds {
		gp.mu.Lock()
		if gp.VoiceChannelID != "" {
			n++
		}
		gp.mu.Unlock()
	}
	return n
}

// EnqueueQuery resolves a text query/URL and enqueues the results (web API
// queue-add). Returns the first track and the queue length after adding.
func (m *Manager) EnqueueQuery(ctx context.Context, guildID, query, requesterID, requester string) (*Track, int, error) {
	tracks, _, err := m.Resolve(ctx, query, requesterID, requester)
	if err != nil {
		return nil, 0, err
	}
	if len(tracks) == 0 {
		return nil, 0, nil
	}
	queueLen, err := m.Enqueue(ctx, guildID, tracks)
	return tracks[0], queueLen, err
}
