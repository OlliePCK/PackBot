// Package jobs holds PackBot's background tasks (Node: scripts/ started from
// ready.js). Each job is a function that runs until its context is cancelled.
package jobs

import (
	"context"
	"log/slog"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/commands"
	"github.com/OlliePCK/packbot/internal/storage"
)

const pollExpiryInterval = 30 * time.Second

// PollExpiry closes expired polls every 30 seconds: marks them closed in the
// DB and edits the poll message to its final results (parity with Node's
// scripts/poll-expiry.js).
func PollExpiry(ctx context.Context, s *discordgo.Session, store *storage.Store) {
	log := slog.With("job", "poll-expiry")
	log.Info("poll expiry checker started", "interval", pollExpiryInterval)

	ticker := time.NewTicker(pollExpiryInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Info("poll expiry checker stopped")
			return
		case <-ticker.C:
			sweepExpiredPolls(ctx, s, store, log)
		}
	}
}

func sweepExpiredPolls(ctx context.Context, s *discordgo.Session, store *storage.Store, log *slog.Logger) {
	polls, err := store.ExpiredOpenPolls(ctx)
	if err != nil {
		log.Error("failed to list expired polls", "error", err)
		return
	}

	for _, p := range polls {
		if err := store.ClosePoll(ctx, p.ID); err != nil {
			log.Error("failed to close poll", "poll", p.ID, "error", err)
			continue
		}

		embed, components := commands.ClosedPollMessage(p)
		_, err := s.ChannelMessageEditComplex(&discordgo.MessageEdit{
			Channel:    p.ChannelID,
			ID:         p.MessageID,
			Embeds:     &[]*discordgo.MessageEmbed{embed},
			Components: &components,
		})
		if err != nil {
			// Message may have been deleted — poll is closed in DB either way.
			log.Warn("failed to edit expired poll message", "poll", p.ID, "error", err)
			continue
		}
		log.Info("closed expired poll", "poll", p.ID, "question", p.Question)
	}
}
