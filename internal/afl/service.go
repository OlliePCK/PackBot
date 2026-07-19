package afl

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
)

// Service owns the model client, the club-emoji registry, and the announcer
// loops. Guilds opt in via /settings set-afl-channel; everything is keyed off
// that column, so any guild can enable the feature.
type Service struct {
	client *Client
	store  *storage.Store
	log    *slog.Logger
	emojis emojiRegistry

	broadcastResolver BroadcastResolver

	mu       sync.Mutex
	cache    []Match
	cachedAt time.Time
}

// New builds the service; baseURL points at the model dashboard.
func New(baseURL string, store *storage.Store) *Service {
	return &Service{
		client: NewClient(baseURL),
		store:  store,
		log:    slog.With("component", "afl"),
		emojis: emojiRegistry{tags: make(map[string]string)},
	}
}

// predictionsCacheTTL bounds dashboard traffic: the kickoff loop ticks every
// minute but fixture times only move on the model's own cron cadence.
const predictionsCacheTTL = 30 * time.Minute

// Predictions returns the current prediction set (cached).
func (s *Service) Predictions(ctx context.Context) ([]Match, error) {
	s.mu.Lock()
	if time.Since(s.cachedAt) < predictionsCacheTTL && s.cache != nil {
		matches := s.cache
		s.mu.Unlock()
		return matches, nil
	}
	s.mu.Unlock()

	matches, err := s.client.Predictions(ctx)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.cache, s.cachedAt = matches, time.Now()
	s.mu.Unlock()
	return matches, nil
}

// Run drives both announcers until ctx is cancelled: the weekly round
// preview (Thursday 19:00 Sydney, 30 minutes after the model's post-team-
// announcement refresh cron) and the T-5-minute kickoff pings.
func (s *Service) Run(ctx context.Context, session *discordgo.Session) {
	s.log.Info("afl announcer started")
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		matches, err := s.Predictions(ctx)
		if err != nil {
			s.log.Error("failed to fetch predictions", "error", err)
			continue
		}
		guilds, err := s.store.AflGuilds(ctx)
		if err != nil {
			s.log.Error("failed to list AFL guilds", "error", err)
			continue
		}
		if len(guilds) == 0 {
			continue
		}

		s.kickoffPings(ctx, session, guilds, matches)
		s.weeklyPost(ctx, session, guilds, matches)
	}
}

// weeklyPost publishes the round preview once per round per guild, inside the
// Thursday-19:00 → Monday-19:00 Sydney window. The model's dataset flips to
// the next round on Tuesday morning (full-cycle cron), so the window keeps
// the post from firing before Thursday's team announcements are in the data.
func (s *Service) weeklyPost(ctx context.Context, session *discordgo.Session, guilds []storage.AflGuild, matches []Match) {
	now := time.Now()
	if now.Sub(lastThursdayAnnounce(now)) > 4*24*time.Hour {
		return
	}
	round, roundMatches := CurrentRound(matches, now)
	if round == "" {
		return
	}
	// Stale guard: don't post a round that has already fully played out.
	last := roundMatches[len(roundMatches)-1]
	if now.After(last.Kickoff.Add(3 * time.Hour)) {
		return
	}

	cards := s.RoundCards(round, roundMatches)
	for _, g := range guilds {
		if g.LastRound == round {
			continue
		}
		if _, err := style.SendComponents(session, g.ChannelID, cards); err != nil {
			s.log.Error("round preview post failed", "guild", g.GuildID, "error", err)
			continue
		}
		if err := s.store.SetAflLastRound(ctx, g.GuildID, round); err != nil {
			s.log.Error("failed to record posted round", "guild", g.GuildID, "error", err)
		}
		s.log.Info("round preview posted", "round", round, "guild", g.GuildID, "matches", len(roundMatches))
	}
}

// lastThursdayAnnounce returns the most recent Thursday 19:00 in Sydney time
// at or before now.
func lastThursdayAnnounce(now time.Time) time.Time {
	n := now.In(sydney)
	daysBack := (int(n.Weekday()) - int(time.Thursday) + 7) % 7
	thu := time.Date(n.Year(), n.Month(), n.Day(), 19, 0, 0, 0, sydney).AddDate(0, 0, -daysBack)
	if thu.After(n) {
		thu = thu.AddDate(0, 0, -7)
	}
	return thu
}
