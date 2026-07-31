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
	round, roundMatches := CurrentRound(matches, now)
	if round == "" || !roundIsCurrent(now, roundMatches) {
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

// roundPostWindow bounds the weekly round-preview window: Thursday 19:00 →
// Monday 19:00 Sydney. Long enough to retry across the weekend if the Thursday
// post is missed, short enough to close before Tuesday's dataset flip.
const roundPostWindow = 4 * 24 * time.Hour

// roundIsCurrent reports whether roundMatches is the round to preview right
// now. It fires only when all three hold:
//
//  1. now is inside this week's Thursday→Monday window;
//  2. the round's OWN earliest fixture also falls inside that window — so the
//     next round appearing early (once the current one finishes mid-window)
//     is not posted before its own Thursday team announcements;
//  3. the round hasn't already fully played out.
//
// Guard (2) was added after a live miss on 2026-07-23: Round 20 was posted the
// previous weekend with preliminary data, which then blocked the proper
// post-announcement Thursday post.
func roundIsCurrent(now time.Time, roundMatches []Match) bool {
	if len(roundMatches) == 0 {
		return false
	}
	windowStart := lastThursdayAnnounce(now)
	if now.Sub(windowStart) > roundPostWindow {
		return false
	}
	earliest, latest := roundMatches[0].Kickoff, roundMatches[0].Kickoff
	for _, m := range roundMatches[1:] {
		if m.Kickoff.Before(earliest) {
			earliest = m.Kickoff
		}
		if m.Kickoff.After(latest) {
			latest = m.Kickoff
		}
	}
	if earliest.After(windowStart.Add(roundPostWindow)) {
		return false // next round showing up early, before its own window
	}
	return !now.After(latest.Add(3 * time.Hour))
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
