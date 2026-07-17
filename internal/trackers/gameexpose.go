package trackers

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
)

const (
	// minRecordedSession filters presence-flap noise (parity: Node's 60s floor).
	minRecordedSession = time.Minute
	// exposeThreshold is the session length that triggers a public callout.
	exposeThreshold = 6 * time.Hour
)

// GameExpose tracks activity sessions per user and records playtime when an
// activity stops; sessions of 6+ hours get announced in the general channel.
type GameExpose struct {
	store *storage.Store
	log   *slog.Logger

	mu sync.Mutex
	// sessions: userID|activityName → session. Start is wall-clock from when
	// the bot first observes the activity (deliberate parity: an activity's
	// own start timestamp may predate the bot seeing it by days).
	sessions map[string]gameSession
}

type gameSession struct {
	start    time.Time
	guildID  string
	username string
}

// NewGameExpose builds the tracker.
func NewGameExpose(store *storage.Store) *GameExpose {
	return &GameExpose{
		store:    store,
		log:      slog.With("tracker", "game-expose"),
		sessions: make(map[string]gameSession),
	}
}

// HandlePresenceUpdate is registered as a discordgo event handler.
func (g *GameExpose) HandlePresenceUpdate(s *discordgo.Session, p *discordgo.PresenceUpdate) {
	if p.GuildID == "" || p.User == nil {
		return
	}
	userID := p.User.ID

	// Current activities that expose a start timestamp (Node parity filter).
	current := make(map[string]bool)
	for _, a := range p.Activities {
		if a != nil && a.Timestamps.StartTimestamp != 0 {
			current[a.Name] = true
		}
	}

	username := resolveUsername(s, p.GuildID, p.User)

	type stopped struct {
		key, game string
		session   gameSession
	}
	var ended []stopped

	g.mu.Lock()
	// Start tracking newly seen activities.
	for name := range current {
		key := userID + "|" + name
		if _, ok := g.sessions[key]; !ok {
			g.sessions[key] = gameSession{start: time.Now(), guildID: p.GuildID, username: username}
		}
	}
	// Detect activities this user stopped (only keys for this user+guild).
	prefix := userID + "|"
	for key, session := range g.sessions {
		if session.guildID != p.GuildID || len(key) <= len(prefix) || key[:len(prefix)] != prefix {
			continue
		}
		game := key[len(prefix):]
		if !current[game] {
			ended = append(ended, stopped{key: key, game: game, session: session})
			delete(g.sessions, key)
		}
	}
	g.mu.Unlock()

	for _, e := range ended {
		elapsed := time.Since(e.session.start)
		if elapsed < minRecordedSession {
			continue
		}

		name := e.session.username
		if name == "Unknown" && username != "Unknown" {
			name = username
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := g.store.RecordPlaytime(ctx, e.session.guildID, userID, name, e.game, int64(elapsed.Seconds()))
		cancel()
		if err != nil {
			g.log.Error("failed to record playtime", "game", e.game, "error", err)
		}

		if elapsed >= exposeThreshold {
			g.announce(s, e.session.guildID, name, e.game, elapsed)
		}
	}
}

func (g *GameExpose) announce(s *discordgo.Session, guildID, username, game string, elapsed time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	profile, err := g.store.GuildProfile(ctx, guildID)
	cancel()
	if err != nil || profile.GeneralChannelID == nil || *profile.GeneralChannelID == "" {
		return
	}

	msg := fmt.Sprintf("%s played **%s** for %.2f hours!", username, game, elapsed.Hours())
	if _, err := s.ChannelMessageSend(*profile.GeneralChannelID, msg); err != nil {
		g.log.Error("failed to send game-expose message", "guild", guildID, "error", err)
	}
}
