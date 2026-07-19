package media

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Reconciler converts complete Jellyfin session snapshots into deterministic
// delivery intents. The first snapshot is treated as startup state and never
// announced; those lifecycles remain suppressed until they disappear.
type Reconciler struct {
	mu          sync.Mutex
	cfg         Config
	initialized bool
	channels    map[string]*trackedChannel
}

type trackedChannel struct {
	observations int
	missing      int
	published    bool
	suppressed   bool
	view         ChannelView
}

// NewReconciler validates and copies cfg so later caller mutations cannot
// expand the guild, viewer, or channel allowlists.
func NewReconciler(cfg Config) (*Reconciler, error) {
	normalized, err := normalizeConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &Reconciler{cfg: normalized, channels: make(map[string]*trackedChannel)}, nil
}

// Reconcile consumes a complete point-in-time session snapshot. Calls should
// be serialized by the polling loop; the internal mutex also makes accidental
// concurrent calls safe.
func (r *Reconciler) Reconcile(now time.Time, sessions []LiveTVSession) []Intent {
	r.mu.Lock()
	defer r.mu.Unlock()

	groups := r.groupSessions(now, sessions)
	if !r.initialized {
		r.initialized = true
		restoredIntents := make([]Intent, 0)
		for channelID, view := range groups {
			if tracked, restored := r.channels[channelID]; restored && tracked.published {
				view.StartedAt = tracked.view.StartedAt
				tracked.view = view
				tracked.observations = r.cfg.ConfirmationPolls
				tracked.missing = 0
				restoredIntents = append(restoredIntents, r.intent(IntentUpsert, now, tracked.view))
				continue
			}
			r.channels[channelID] = &trackedChannel{
				observations: 1,
				suppressed:   true,
				view:         view,
			}
		}
		sortIntents(restoredIntents)
		return restoredIntents
	}

	intents := make([]Intent, 0)
	for _, channelID := range sortedGroupIDs(groups) {
		view := groups[channelID]
		tracked, exists := r.channels[channelID]
		if !exists {
			r.channels[channelID] = &trackedChannel{observations: 1, view: view}
			continue
		}

		tracked.missing = 0
		tracked.observations++
		view.StartedAt = tracked.view.StartedAt
		changed := !viewsEqual(tracked.view, view)
		tracked.view = view

		if tracked.suppressed {
			continue
		}
		if !tracked.published && tracked.observations >= r.cfg.ConfirmationPolls {
			tracked.published = true
			intents = append(intents, r.intent(IntentUpsert, now, tracked.view))
			continue
		}
		if tracked.published && changed {
			intents = append(intents, r.intent(IntentUpsert, now, tracked.view))
		}
	}

	for _, channelID := range sortedTrackedIDs(r.channels) {
		if _, present := groups[channelID]; present {
			continue
		}
		tracked := r.channels[channelID]
		if !tracked.published && !tracked.suppressed {
			// Confirmation is consecutive: one absence cancels an unpublished
			// candidate rather than preserving its observation count.
			delete(r.channels, channelID)
			continue
		}
		tracked.missing++
		if tracked.missing < r.cfg.EndAfterMissingPolls {
			continue
		}
		if tracked.published {
			intents = append(intents, r.intent(IntentEnd, now, tracked.view))
		}
		delete(r.channels, channelID)
	}

	sortIntents(intents)
	return intents
}

func (r *Reconciler) intent(kind IntentKind, now time.Time, view ChannelView) Intent {
	view.Viewers = append([]string(nil), view.Viewers...)
	return Intent{
		Kind:                 kind,
		MainGuildID:          r.cfg.MainGuildID,
		DestinationChannelID: r.cfg.GeneralChannelID,
		Channel:              view,
		At:                   now,
	}
}

type programChoice struct {
	id   string
	name string
}

type channelGroup struct {
	viewers  map[string]string
	programs map[programChoice]int
}

// resolveChannel returns the public metadata for a channel: the curated entry
// when one exists, otherwise (in AllowAllChannels mode) metadata derived from
// the Jellyfin session itself — the raw channel name and a generated token-
// free watch URL. Returns ok=false when the channel must be ignored.
func (r *Reconciler) resolveChannel(channelID string, session LiveTVSession) (ChannelConfig, bool) {
	if channel, ok := r.cfg.Channels[channelID]; ok {
		return channel, true
	}
	if !r.cfg.AllowAllChannels {
		return ChannelConfig{}, false
	}
	name := cleanText(session.ChannelName)
	if name == "" {
		name = "Live TV"
	}
	watchURL := ""
	if built, err := PublicChannelURL(r.cfg.PublicBaseURL, channelID); err == nil {
		watchURL = built // absent URL just drops the button; occupancy still shows
	}
	return ChannelConfig{DisplayName: name, WatchURL: watchURL}, true
}

func (r *Reconciler) groupSessions(now time.Time, sessions []LiveTVSession) map[string]ChannelView {
	groups := make(map[string]*channelGroup)
	meta := make(map[string]ChannelConfig)
	for _, session := range sessions {
		channelID := canonicalJellyfinID(session.ChannelID)
		channel, allowed := r.resolveChannel(channelID, session)
		if !allowed {
			continue
		}

		viewerID := canonicalJellyfinID(session.ViewerID)
		alias, known := r.cfg.ViewerAliases[viewerID]
		if !known {
			if r.cfg.UnknownViewerPolicy == IgnoreUnknownViewers {
				continue
			}
			alias = "Someone"
			if viewerID == "" {
				// Jellyfin users normally have IDs. This stable per-snapshot key
				// still avoids rendering any raw server data if one is missing.
				viewerID = "anonymous"
			}
		}

		group := groups[channelID]
		if group == nil {
			group = &channelGroup{
				viewers:  make(map[string]string),
				programs: make(map[programChoice]int),
			}
			groups[channelID] = group
			meta[channelID] = channel
		}
		group.viewers[viewerID] = alias
		choice := programChoice{
			id:   strings.TrimSpace(session.ProgramID),
			name: cleanText(session.ProgramName),
		}
		group.programs[choice]++
	}

	views := make(map[string]ChannelView, len(groups))
	for channelID, group := range groups {
		channel := meta[channelID]
		viewers := make([]string, 0, len(group.viewers))
		for _, alias := range group.viewers {
			viewers = append(viewers, alias)
		}
		sort.Strings(viewers)
		program := chooseProgram(group.programs)
		views[channelID] = ChannelView{
			ChannelID:   channelID,
			ChannelName: channel.DisplayName,
			WatchURL:    channel.WatchURL,
			ProgramID:   program.id,
			ProgramName: program.name,
			Viewers:     viewers,
			StartedAt:   now,
		}
	}
	return views
}

func chooseProgram(programs map[programChoice]int) programChoice {
	var best programChoice
	bestCount := -1
	for program, count := range programs {
		if count > bestCount || (count == bestCount && programKey(program) < programKey(best)) {
			best = program
			bestCount = count
		}
	}
	return best
}

func programKey(program programChoice) string {
	return fmt.Sprintf("%s\x00%s", program.id, program.name)
}

func sortedGroupIDs(groups map[string]ChannelView) []string {
	ids := make([]string, 0, len(groups))
	for id := range groups {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func sortedTrackedIDs(channels map[string]*trackedChannel) []string {
	ids := make([]string, 0, len(channels))
	for id := range channels {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func viewsEqual(a, b ChannelView) bool {
	if a.ChannelID != b.ChannelID || a.ChannelName != b.ChannelName || a.WatchURL != b.WatchURL ||
		a.ProgramID != b.ProgramID || a.ProgramName != b.ProgramName || !a.StartedAt.Equal(b.StartedAt) ||
		len(a.Viewers) != len(b.Viewers) {
		return false
	}
	for i := range a.Viewers {
		if a.Viewers[i] != b.Viewers[i] {
			return false
		}
	}
	return true
}
