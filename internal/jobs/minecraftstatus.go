package jobs

import (
	"context"
	"fmt"
	"log/slog"
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

	check := func() {
		pingCtx, cancel := context.WithTimeout(ctx, mcPingTimeout)
		status, err := mc.Ping(pingCtx)
		cancel()

		state, changed := tracker.observe(err == nil)
		if !changed {
			return
		}

		embed := mcDownEmbed(mc.Addr)
		if state == mcUp {
			embed = mcUpEmbed(mc.Addr, status)
		}
		if _, sendErr := s.ChannelMessageSendEmbed(channelID, embed); sendErr != nil {
			log.Error("failed to post minecraft status", "error", sendErr, "state", state)
			return
		}
		log.Info("minecraft status changed", "state", state, "pingError", err)
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

func mcDownEmbed(addr string) *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title:       "Minecraft",
		Description: fmt.Sprintf("%s | **Server is unreachable** — `%s`", style.Emotes.Error, addr),
		Color:       style.ColorError,
		Footer:      style.Footer(),
	}
}
