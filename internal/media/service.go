package media

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
)

type sessionSource interface {
	LiveTVSessions(context.Context) ([]LiveTVSession, error)
}

type liveCardStore interface {
	MediaLiveCards(context.Context, string) ([]storage.MediaLiveCard, error)
	ClaimMediaLiveCard(context.Context, string, string, string, time.Time) (bool, error)
	ReleaseMediaLiveCard(context.Context, string, string, string) error
	ActivateMediaLiveCard(context.Context, string, string, string, string, time.Time) error
	TouchMediaLiveCard(context.Context, string, string, string, time.Time) error
	DeleteMediaLiveCard(context.Context, string, string) error
}

type cardMessenger interface {
	Send(channelID string, view ChannelView) (messageID string, err error)
	Edit(channelID, messageID string, view ChannelView) error
	Delete(channelID, messageID string) error
}

// Service polls Jellyfin and owns the restart-safe Discord delivery boundary.
// Reconciliation is serialized, so at most one delivery attempt for a channel
// is in flight.
type Service struct {
	cfg          Config
	pollInterval time.Duration
	source       sessionSource
	store        liveCardStore
	messenger    cardMessenger
	reconciler   *Reconciler
	log          *slog.Logger

	cards          map[string]storage.MediaLiveCard
	pendingEnds    map[string]Intent
	pendingUpserts map[string]Intent
}

// NewService wires the production Jellyfin/store/Discord adapters.
func NewService(
	cfg Config,
	pollInterval time.Duration,
	source sessionSource,
	store *storage.Store,
	session *discordgo.Session,
) (*Service, error) {
	return newService(cfg, pollInterval, source, store, newDiscordMessenger(session))
}

func newService(
	cfg Config,
	pollInterval time.Duration,
	source sessionSource,
	store liveCardStore,
	messenger cardMessenger,
) (*Service, error) {
	if pollInterval <= 0 {
		return nil, fmt.Errorf("media: poll interval must be positive")
	}
	if source == nil || store == nil || messenger == nil {
		return nil, fmt.Errorf("media: source, store, and messenger are required")
	}
	normalized, err := normalizeConfig(cfg)
	if err != nil {
		return nil, err
	}
	reconciler, err := NewReconciler(normalized)
	if err != nil {
		return nil, err
	}
	return &Service{
		cfg:            normalized,
		pollInterval:   pollInterval,
		source:         source,
		store:          store,
		messenger:      messenger,
		reconciler:     reconciler,
		log:            slog.With("component", "media"),
		cards:          make(map[string]storage.MediaLiveCard),
		pendingEnds:    make(map[string]Intent),
		pendingUpserts: make(map[string]Intent),
	}, nil
}

// Run blocks until ctx is cancelled. A failed snapshot is skipped entirely;
// it never looks like every viewer stopped.
func (s *Service) Run(ctx context.Context) {
	if err := s.restore(ctx); err != nil {
		s.log.Error("Live TV cards disabled; failed to restore delivery state", "error", err)
		return
	}
	s.log.Info(
		"Live TV cards started",
		"guild", s.cfg.MainGuildID,
		"channels", len(s.cfg.Channels),
		"poll_interval", s.pollInterval,
	)

	s.poll(ctx)
	ticker := time.NewTicker(s.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.poll(ctx)
		}
	}
}

func (s *Service) restore(ctx context.Context) error {
	cards, err := s.store.MediaLiveCards(ctx, s.cfg.MainGuildID)
	if err != nil {
		return err
	}
	firstSeen := make(map[string]time.Time)
	for _, card := range cards {
		channelID := canonicalJellyfinID(card.JellyfinChannelID)
		if card.GuildID != s.cfg.MainGuildID || card.DiscordChannelID != s.cfg.GeneralChannelID {
			// A row whose destination no longer matches the configured channel
			// (e.g. the general channel was reconfigured) is retained as an
			// inert blocking claim, never acted on. It must NOT be deleted from
			// the store — that would free the claim and risk a duplicate card
			// for this Jellyfin channel — and its Discord message must NOT be
			// touched, since it lives in a channel this bot no longer manages.
			// deliverUpsert/deliverEnd both refuse any card whose destination is
			// foreign, so holding it in s.cards blocks the channel without ever
			// sending, editing, or deleting on Discord.
			s.log.Error(
				"retaining Live TV delivery state outside the configured destination as an inert block; not touching Discord",
				"channel_id", channelID,
			)
			s.cards[channelID] = card
			continue
		}

		_, curated := s.cfg.Channels[channelID]
		allowed := curated || s.cfg.AllowAllChannels
		if card.Status == storage.MediaCardActive && !allowed {
			if card.DiscordMessageID != "" {
				if err := s.messenger.Delete(card.DiscordChannelID, card.DiscordMessageID); err != nil {
					return fmt.Errorf("media: delete removed-channel card %s: %w", channelID, err)
				}
			}
			if err := s.store.DeleteMediaLiveCard(ctx, card.GuildID, card.JellyfinChannelID); err != nil {
				return fmt.Errorf("media: retire removed-channel card %s: %w", channelID, err)
			}
			continue
		}

		switch {
		case card.Status == storage.MediaCardPending:
			if !allowed {
				s.log.Error(
					"Live TV card has ambiguous pending delivery for a removed channel; state quarantined",
					"channel_id", channelID,
				)
				continue
			}
			s.cards[channelID] = card
			s.log.Error(
				"Live TV card has ambiguous pending delivery; channel is blocked to prevent duplicates",
				"channel_id", channelID,
			)
		case card.Status != storage.MediaCardActive || card.DiscordMessageID == "":
			s.log.Error("Live TV card has invalid persisted state", "channel_id", channelID)
		default:
			s.cards[channelID] = card
			firstSeen[channelID] = card.FirstSeenAt
		}
	}
	return s.reconciler.RestorePublished(firstSeen)
}

func (s *Service) poll(ctx context.Context) {
	s.flushPending(ctx)

	sessions, err := s.source.LiveTVSessions(ctx)
	if err != nil {
		s.log.Error("failed to fetch Jellyfin sessions; snapshot skipped", "error", err)
		return
	}
	intents := s.reconciler.Reconcile(time.Now(), sessions)
	for _, intent := range intents {
		s.handleIntent(ctx, intent)
	}
}

func (s *Service) flushPending(ctx context.Context) {
	for _, channelID := range sortedIntentIDs(s.pendingEnds) {
		intent := s.pendingEnds[channelID]
		if retry, err := s.deliverEnd(ctx, intent); err != nil {
			s.log.Error("failed to finish Live TV card", "channel_id", channelID, "error", err)
			if !retry {
				delete(s.pendingEnds, channelID)
			}
			continue
		}
		delete(s.pendingEnds, channelID)
	}
	for _, channelID := range sortedIntentIDs(s.pendingUpserts) {
		if _, ending := s.pendingEnds[channelID]; ending {
			continue
		}
		intent := s.pendingUpserts[channelID]
		if retry, err := s.deliverUpsert(ctx, intent); err != nil {
			s.log.Error("failed to deliver Live TV card", "channel_id", channelID, "error", err)
			if !retry {
				delete(s.pendingUpserts, channelID)
			}
			continue
		}
		delete(s.pendingUpserts, channelID)
	}
}

func (s *Service) handleIntent(ctx context.Context, intent Intent) {
	channelID := canonicalJellyfinID(intent.Channel.ChannelID)
	if intent.MainGuildID != s.cfg.MainGuildID ||
		intent.DestinationChannelID != s.cfg.GeneralChannelID {
		s.log.Error("blocked Live TV intent with mismatched destination")
		return
	}

	switch intent.Kind {
	case IntentEnd:
		delete(s.pendingUpserts, channelID)
		if retry, err := s.deliverEnd(ctx, intent); err != nil {
			s.log.Error("failed to finish Live TV card", "channel_id", channelID, "error", err)
			if retry {
				s.pendingEnds[channelID] = intent
			}
		}
	case IntentUpsert:
		if _, ending := s.pendingEnds[channelID]; ending {
			s.pendingUpserts[channelID] = intent
			return
		}
		if retry, err := s.deliverUpsert(ctx, intent); err != nil {
			s.log.Error("failed to deliver Live TV card", "channel_id", channelID, "error", err)
			if retry {
				s.pendingUpserts[channelID] = intent
			}
		}
	}
}

func (s *Service) deliverUpsert(ctx context.Context, intent Intent) (bool, error) {
	channelID := canonicalJellyfinID(intent.Channel.ChannelID)
	intent.Channel.ChannelID = channelID
	if card, exists := s.cards[channelID]; exists {
		if card.GuildID != s.cfg.MainGuildID ||
			canonicalJellyfinID(card.JellyfinChannelID) != channelID ||
			card.DiscordChannelID != s.cfg.GeneralChannelID {
			return false, fmt.Errorf("persisted Live TV card is outside the configured destination")
		}
		if card.Status == storage.MediaCardPending && card.DiscordMessageID == "" {
			return false, fmt.Errorf("pending delivery has no known Discord message ID")
		}
		if card.Status == storage.MediaCardPending {
			if err := s.store.ActivateMediaLiveCard(
				ctx,
				s.cfg.MainGuildID,
				card.JellyfinChannelID,
				s.cfg.GeneralChannelID,
				card.DiscordMessageID,
				intent.At,
			); err != nil {
				return true, err
			}
			card.Status = storage.MediaCardActive
			s.cards[channelID] = card
		}
		if err := s.messenger.Edit(card.DiscordChannelID, card.DiscordMessageID, intent.Channel); err != nil {
			if errors.Is(err, ErrCardNotFound) {
				if err := s.store.DeleteMediaLiveCard(ctx, s.cfg.MainGuildID, card.JellyfinChannelID); err != nil {
					return true, err
				}
				delete(s.cards, channelID)
				return s.createCard(ctx, intent)
			}
			return true, err
		}
		if err := s.store.TouchMediaLiveCard(
			ctx,
			s.cfg.MainGuildID,
			card.JellyfinChannelID,
			card.DiscordMessageID,
			intent.At,
		); err != nil {
			return true, err
		}
		return false, nil
	}
	return s.createCard(ctx, intent)
}

func (s *Service) createCard(ctx context.Context, intent Intent) (bool, error) {
	channelID := canonicalJellyfinID(intent.Channel.ChannelID)
	claimed, err := s.store.ClaimMediaLiveCard(
		ctx,
		s.cfg.MainGuildID,
		channelID,
		s.cfg.GeneralChannelID,
		intent.Channel.StartedAt,
	)
	if err != nil {
		return true, err
	}
	if !claimed {
		return false, fmt.Errorf("delivery state already exists; refusing duplicate send")
	}

	messageID, err := s.messenger.Send(s.cfg.GeneralChannelID, intent.Channel)
	if err != nil {
		if isDefiniteDiscordSendFailure(err) {
			if releaseErr := s.store.ReleaseMediaLiveCard(
				ctx,
				s.cfg.MainGuildID,
				channelID,
				s.cfg.GeneralChannelID,
			); releaseErr != nil {
				s.cards[channelID] = storage.MediaLiveCard{
					GuildID:           s.cfg.MainGuildID,
					JellyfinChannelID: channelID,
					DiscordChannelID:  s.cfg.GeneralChannelID,
					Status:            storage.MediaCardPending,
					FirstSeenAt:       intent.Channel.StartedAt,
					LastSeenAt:        intent.At,
				}
				return false, errors.Join(
					fmt.Errorf("Discord definitively rejected the send: %w", err),
					fmt.Errorf("release pending delivery claim: %w", releaseErr),
				)
			}
			delete(s.cards, channelID)
			return true, fmt.Errorf("Discord definitively rejected the send; pending claim released: %w", err)
		}
		s.cards[channelID] = storage.MediaLiveCard{
			GuildID:           s.cfg.MainGuildID,
			JellyfinChannelID: channelID,
			DiscordChannelID:  s.cfg.GeneralChannelID,
			Status:            storage.MediaCardPending,
			FirstSeenAt:       intent.Channel.StartedAt,
			LastSeenAt:        intent.At,
		}
		return false, fmt.Errorf("Discord send returned an ambiguous error; pending claim retained: %w", err)
	}

	card := storage.MediaLiveCard{
		GuildID:           s.cfg.MainGuildID,
		JellyfinChannelID: channelID,
		DiscordChannelID:  s.cfg.GeneralChannelID,
		DiscordMessageID:  messageID,
		Status:            storage.MediaCardPending,
		FirstSeenAt:       intent.Channel.StartedAt,
		LastSeenAt:        intent.At,
	}
	s.cards[channelID] = card
	if err := s.store.ActivateMediaLiveCard(
		ctx,
		s.cfg.MainGuildID,
		channelID,
		s.cfg.GeneralChannelID,
		messageID,
		intent.At,
	); err != nil {
		return true, err
	}
	card.Status = storage.MediaCardActive
	s.cards[channelID] = card
	return false, nil
}

func (s *Service) deliverEnd(ctx context.Context, intent Intent) (bool, error) {
	channelID := canonicalJellyfinID(intent.Channel.ChannelID)
	card, exists := s.cards[channelID]
	if !exists {
		return false, nil
	}
	if card.GuildID != s.cfg.MainGuildID ||
		canonicalJellyfinID(card.JellyfinChannelID) != channelID ||
		card.DiscordChannelID != s.cfg.GeneralChannelID {
		return false, fmt.Errorf("persisted Live TV card is outside the configured destination")
	}
	if card.DiscordMessageID == "" {
		return false, fmt.Errorf("pending delivery has no known Discord message ID")
	}
	if err := s.messenger.Delete(card.DiscordChannelID, card.DiscordMessageID); err != nil {
		return true, err
	}
	if err := s.store.DeleteMediaLiveCard(ctx, s.cfg.MainGuildID, card.JellyfinChannelID); err != nil {
		return true, err
	}
	delete(s.cards, channelID)
	return false, nil
}

func sortedIntentIDs(values map[string]Intent) []string {
	ids := make([]string, 0, len(values))
	for id := range values {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
