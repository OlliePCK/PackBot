package jobs

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/minecraft"
	"github.com/OlliePCK/packbot/internal/style"
)

const (
	// mcPollInterval is how often the server is pinged. A status ping is a few
	// hundred bytes, so this is cheap; the limit is how fast we want to notice.
	mcPollInterval = time.Minute

	// mcPingTimeout bounds one ping. Shorter than the poll interval so a hung
	// dial can never overlap the next tick.
	mcPingTimeout = 10 * time.Second

	// mcFailureThreshold is how many consecutive failed pings before the server
	// is announced as down. One dropped packet, a brief restart, or a Tailscale
	// re-handshake should not wake the channel — at a 1 minute interval this
	// means roughly 3 minutes of genuine downtime before anyone is told.
	mcFailureThreshold = 3
)

// playerTracker diffs the online roster between polls to derive join and leave
// events. It relies on the status ping's player sample being complete, which
// requires spigot.yml's sample-count to be at least max-players — otherwise
// players beyond the cap look like they are constantly joining and leaving.
type playerTracker struct {
	known  map[string]struct{}
	seeded bool
}

func newPlayerTracker() *playerTracker {
	return &playerTracker{known: make(map[string]struct{})}
}

// observe records the current roster and returns who joined and who left.
//
// The first call after construction or reset only establishes a baseline and
// reports nothing, so a bot restart doesn't announce everyone already online.
func (t *playerTracker) observe(names []string) (joined, left []string) {
	current := make(map[string]struct{}, len(names))
	for _, n := range names {
		if n = strings.TrimSpace(n); n != "" {
			current[n] = struct{}{}
		}
	}

	if !t.seeded {
		t.known, t.seeded = current, true
		return nil, nil
	}

	for n := range current {
		if _, ok := t.known[n]; !ok {
			joined = append(joined, n)
		}
	}
	for n := range t.known {
		if _, ok := current[n]; !ok {
			left = append(left, n)
		}
	}
	sort.Strings(joined)
	sort.Strings(left)

	t.known = current
	return joined, left
}

// reset drops the baseline. Called when the server goes unreachable so that
// recovery re-seeds silently rather than announcing the whole roster as joins.
func (t *playerTracker) reset() {
	t.known = make(map[string]struct{})
	t.seeded = false
}

// mcState is the tracked reachability of the server.
type mcState int

const (
	mcUnknown mcState = iota
	mcUp
	mcDown
)

// mcTracker converts a stream of ping outcomes into up/down transitions,
// applying the failure threshold. It is deliberately free of Discord and
// network types so the debounce logic can be tested directly.
type mcTracker struct {
	state     mcState
	failures  int
	threshold int
}

func newMCTracker(threshold int) *mcTracker {
	if threshold < 1 {
		threshold = 1
	}
	return &mcTracker{threshold: threshold}
}

// observe records one ping outcome and reports the current state plus whether
// it just changed.
//
// The first settled observation only establishes a baseline and reports no
// change: restarting the bot should not announce a server that was already up,
// nor re-announce one that was already down.
func (t *mcTracker) observe(ok bool) (state mcState, changed bool) {
	if ok {
		t.failures = 0
		if t.state == mcUp {
			return mcUp, false
		}
		changed = t.state != mcUnknown
		t.state = mcUp
		return mcUp, changed
	}

	t.failures++
	if t.failures < t.threshold {
		// Not yet convinced it is down; hold the previous state.
		return t.state, false
	}
	if t.state == mcDown {
		return mcDown, false
	}
	changed = t.state != mcUnknown
	t.state = mcDown
	return mcDown, changed
}

// MinecraftStatus polls the Minecraft server and posts to channelID whenever it
// transitions between reachable and unreachable.
//
// Like the other jobs it is started with `go jobs.MinecraftStatus(...)` and
// exits when ctx is cancelled. It no-ops when either the client or the channel
// is unconfigured.
func MinecraftStatus(ctx context.Context, s *discordgo.Session, mc *minecraft.Client, channelID string) {
	log := slog.With("job", "minecraft")

	if mc == nil || channelID == "" {
		log.Warn("minecraft status notifications disabled",
			"hasAddress", mc != nil, "hasChannel", channelID != "")
		return
	}

	log.Info("minecraft status started",
		"addr", mc.Addr, "interval", mcPollInterval, "threshold", mcFailureThreshold)

	tracker := newMCTracker(mcFailureThreshold)
	players := newPlayerTracker()

	check := func() {
		pingCtx, cancel := context.WithTimeout(ctx, mcPingTimeout)
		status, err := mc.Ping(pingCtx)
		cancel()

		state, changed := tracker.observe(err == nil)

		if changed {
			if state == mcDown {
				// Forget the roster: when the server returns, re-seed quietly
				// instead of announcing everyone as a fresh join.
				players.reset()
			}
			embed := mcDownEmbed(mc.Addr)
			if state == mcUp {
				embed = mcUpEmbed(mc.Addr, status)
			}
			if _, sendErr := s.ChannelMessageSendEmbed(channelID, embed); sendErr != nil {
				log.Error("failed to post minecraft status", "error", sendErr, "state", state)
			} else {
				log.Info("minecraft status changed", "state", state, "pingError", err)
			}
		}

		// Roster diffing only makes sense on a successful ping.
		if err != nil || status == nil {
			return
		}
		names := make([]string, 0, len(status.Players.Sample))
		for _, p := range status.Players.Sample {
			names = append(names, p.Name)
		}
		joined, left := players.observe(names)
		if len(joined) == 0 && len(left) == 0 {
			return
		}
		if _, sendErr := s.ChannelMessageSendEmbed(channelID,
			mcRosterEmbed(joined, left, status.Players.Online, status.Players.Max)); sendErr != nil {
			log.Error("failed to post roster change", "error", sendErr)
			return
		}
		log.Info("minecraft roster changed", "joined", joined, "left", left)
	}

	// Establish the baseline immediately rather than after a full interval, so
	// a server that goes down during a bot restart is still caught promptly.
	check()

	ticker := time.NewTicker(mcPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Info("minecraft status stopped")
			return
		case <-ticker.C:
			check()
		}
	}
}

func mcUpEmbed(addr string, st *minecraft.Status) *discordgo.MessageEmbed {
	embed := &discordgo.MessageEmbed{
		Title:       "Minecraft",
		Description: fmt.Sprintf("%s | **Server is back online** — `%s`", style.Emotes.Success, addr),
		Color:       style.ColorSuccess,
		Footer:      style.Footer(),
	}
	if st != nil {
		embed.Fields = []*discordgo.MessageEmbedField{
			{
				Name:   "Players",
				Value:  fmt.Sprintf("%d / %d", st.Players.Online, st.Players.Max),
				Inline: true,
			},
			{
				Name:   "Version",
				Value:  st.Version.Name,
				Inline: true,
			},
		}
	}
	return embed
}

// mcRosterEmbed renders join/leave activity for one poll cycle.
func mcRosterEmbed(joined, left []string, online, max int) *discordgo.MessageEmbed {
	var b strings.Builder
	if len(joined) > 0 {
		fmt.Fprintf(&b, "**+** %s\n", strings.Join(joined, ", "))
	}
	if len(left) > 0 {
		fmt.Fprintf(&b, "**−** %s\n", strings.Join(left, ", "))
	}
	fmt.Fprintf(&b, "%d / %d online", online, max)

	return &discordgo.MessageEmbed{
		Title:       "Minecraft",
		Description: b.String(),
		Color:       style.ColorBrand,
		Footer:      style.Footer(),
	}
}

func mcDownEmbed(addr string) *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title:       "Minecraft",
		Description: fmt.Sprintf("%s | **Server is unreachable** — `%s`", style.Emotes.Error, addr),
		Color:       style.ColorError,
		Footer:      style.Footer(),
	}
}
