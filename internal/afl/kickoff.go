package afl

import (
	"context"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
)

// kickoffPings claims and records each guild delivery independently. A failed
// Discord send releases its lease so the next minute can retry.
func (s *Service) kickoffPings(
	ctx context.Context,
	session *discordgo.Session,
	guilds []storage.AflGuild,
	matches []Match,
) {
	now := time.Now()
	for _, match := range matches {
		until := match.Kickoff.Sub(now)
		if until <= 0 || until > 5*time.Minute {
			continue
		}
		for _, guild := range guilds {
			key := storage.AflAnnouncementKey{
				GuildID:     guild.GuildID,
				Kind:        "kickoff",
				GameID:      match.GameID,
				KickoffUnix: match.Kickoff.Unix(),
			}
			claim, claimed, err := s.store.ClaimAflAnnouncement(ctx, key)
			if err != nil {
				s.log.Error(
					"failed to claim kickoff ping",
					"guild", guild.GuildID,
					"error", err,
				)
				continue
			}
			if !claimed {
				continue
			}

			var watchLink *WatchLink
			if s.broadcastResolver != nil {
				watchLink, err = s.broadcastResolver.ResolveAFL(ctx, guild.GuildID, match)
				if err != nil {
					s.log.Error(
						"AFL broadcast resolution failed; sending reminder without link",
						"guild", guild.GuildID,
						"error", err,
					)
					watchLink = nil
				}
			}

			card := s.KickoffCardWithLink(match, watchLink)
			if _, err := style.SendComponents(session, guild.ChannelID, card); err != nil {
				s.log.Error("kickoff ping failed", "guild", guild.GuildID, "error", err)
				if releaseErr := s.store.ReleaseAflAnnouncement(ctx, claim, err); releaseErr != nil {
					s.log.Error(
						"failed to release kickoff ping claim",
						"guild", guild.GuildID,
						"error", releaseErr,
					)
				}
				continue
			}
			if err := s.store.CompleteAflAnnouncement(ctx, claim); err != nil {
				s.log.Error(
					"kickoff ping sent but delivery could not be recorded",
					"guild", guild.GuildID,
					"error", err,
				)
				continue
			}
			s.log.Info(
				"kickoff ping sent",
				"match", match.Home+" v "+match.Away,
				"guild", guild.GuildID,
				"watch_link", watchLink != nil,
			)
		}
	}
}
