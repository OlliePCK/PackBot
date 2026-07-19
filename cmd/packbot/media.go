package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/afl"
	"github.com/OlliePCK/packbot/internal/config"
	"github.com/OlliePCK/packbot/internal/media"
	"github.com/OlliePCK/packbot/internal/storage"
)

type liveTVSessionSource interface {
	LiveTVSessions(context.Context) ([]media.LiveTVSession, error)
}

type aflBroadcastSource interface {
	Resolve(
		context.Context,
		media.AFLMatchQuery,
		[]media.LiveTVSession,
	) (*media.AFLBroadcast, error)
}

// mediaBroadcastAdapter is the immutable main-guild boundary between the
// global AFL announcer and the private Jellyfin integration.
type mediaBroadcastAdapter struct {
	mainGuildID string
	sessions    liveTVSessionSource
	resolver    aflBroadcastSource
}

func (a *mediaBroadcastAdapter) ResolveAFL(
	ctx context.Context,
	guildID string,
	match afl.Match,
) (*afl.WatchLink, error) {
	if strings.TrimSpace(guildID) != a.mainGuildID {
		return nil, nil
	}
	sessions, err := a.sessions.LiveTVSessions(ctx)
	if err != nil {
		return nil, err
	}
	broadcast, err := a.resolver.Resolve(ctx, media.AFLMatchQuery{
		Home:    match.Home,
		Away:    match.Away,
		Kickoff: match.Kickoff,
	}, sessions)
	if err != nil || broadcast == nil {
		return nil, err
	}

	label := "Watch on Jellyfin"
	switch broadcast.State {
	case media.AFLBroadcastJoin:
		label = "Join on Jellyfin"
	case media.AFLBroadcastWatch:
	default:
		return nil, fmt.Errorf("media: unsupported AFL broadcast state %q", broadcast.State)
	}
	return &afl.WatchLink{
		URL:         broadcast.WatchURL,
		Label:       label,
		ChannelName: broadcast.ChannelName,
	}, nil
}

func startMediaIntegration(
	ctx context.Context,
	cfg config.Media,
	store *storage.Store,
	session *discordgo.Session,
	aflService *afl.Service,
) error {
	if !cfg.Enabled {
		return nil
	}
	if cfg.ValidationError != nil {
		return cfg.ValidationError
	}
	if store == nil || session == nil {
		return fmt.Errorf("media: storage and Discord session are required")
	}

	profile, err := store.GuildProfile(ctx, cfg.GuildID)
	if err != nil {
		return fmt.Errorf("media: load main guild profile: %w", err)
	}
	if profile.GeneralChannelID == nil || strings.TrimSpace(*profile.GeneralChannelID) == "" {
		return fmt.Errorf("media: main guild has no general channel configured")
	}
	generalChannelID := strings.TrimSpace(*profile.GeneralChannelID)
	generalChannel, err := session.Channel(generalChannelID)
	if err != nil {
		return fmt.Errorf("media: validate main guild general channel: %w", err)
	}
	if generalChannel.GuildID != cfg.GuildID {
		return fmt.Errorf("media: configured general channel is outside the main guild")
	}
	if generalChannel.Type != discordgo.ChannelTypeGuildText &&
		generalChannel.Type != discordgo.ChannelTypeGuildNews {
		return fmt.Errorf("media: configured general channel is not a text channel")
	}

	jellyfin, err := media.NewJellyfinClient(cfg.JellyfinURL, cfg.JellyfinAPIKey)
	if err != nil {
		return err
	}
	channels := make(map[string]media.ChannelConfig, len(cfg.Channels))
	for channelID, displayName := range cfg.Channels {
		watchURL, err := media.PublicChannelURL(cfg.JellyfinPublicURL, channelID)
		if err != nil {
			return err
		}
		channels[channelID] = media.ChannelConfig{
			DisplayName: displayName,
			WatchURL:    watchURL,
		}
	}

	liveTV, err := media.NewService(media.Config{
		MainGuildID:          cfg.GuildID,
		GeneralChannelID:     generalChannelID,
		ViewerAliases:        cfg.ViewerAliases,
		UnknownViewerPolicy:  media.IgnoreUnknownViewers,
		Channels:             channels,
		ConfirmationPolls:    confirmationPolls(cfg.AnnounceDelay, cfg.PollInterval),
		EndAfterMissingPolls: missingPolls(cfg.StopGrace, cfg.PollInterval),
	}, cfg.PollInterval, jellyfin, store, session)
	if err != nil {
		return err
	}

	if aflService != nil && len(cfg.AFLChannelIDs) != 0 {
		programs, err := media.NewJellyfinProgramsClient(cfg.JellyfinURL, cfg.JellyfinAPIKey)
		if err != nil {
			return err
		}
		resolver, err := media.NewAFLBroadcastResolver(
			programs,
			cfg.JellyfinPublicURL,
			cfg.AFLChannelIDs,
		)
		if err != nil {
			return err
		}
		aflService.SetBroadcastResolver(&mediaBroadcastAdapter{
			mainGuildID: cfg.GuildID,
			sessions:    jellyfin,
			resolver:    resolver,
		})
	}

	go liveTV.Run(ctx)
	return nil
}

func confirmationPolls(delay, pollInterval time.Duration) int {
	if pollInterval <= 0 {
		return 2
	}
	polls := int((delay+pollInterval-1)/pollInterval) + 1
	if polls < 2 {
		return 2
	}
	return polls
}

func missingPolls(grace, pollInterval time.Duration) int {
	if pollInterval <= 0 {
		return 1
	}
	polls := int((grace + pollInterval - 1) / pollInterval)
	if polls < 1 {
		return 1
	}
	return polls
}
