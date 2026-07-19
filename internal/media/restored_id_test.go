package media

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/OlliePCK/packbot/internal/storage"
)

func TestServiceUsesPersistedIDFormForExistingStoreRow(t *testing.T) {
	ctx := context.Background()
	firstSeen := time.Date(2026, 7, 19, 5, 0, 0, 0, time.UTC)
	store := &exactRestoredIDStore{card: storage.MediaLiveCard{
		GuildID:           lifecycleGuildID,
		JellyfinChannelID: lifecycleChannelIDUUID,
		DiscordChannelID:  lifecycleGeneralID,
		DiscordMessageID:  lifecycleMessageID,
		Status:            storage.MediaCardActive,
		FirstSeenAt:       firstSeen,
		LastSeenAt:        firstSeen,
	}}
	messenger := &lifecycleMessenger{}
	service, err := newService(
		lifecycleConfig(),
		15*time.Second,
		&lifecycleSource{},
		store,
		messenger,
	)
	if err != nil {
		t.Fatalf("newService: %v", err)
	}
	if err := service.restore(ctx); err != nil {
		t.Fatalf("restore: %v", err)
	}

	intent := Intent{
		Kind:                 IntentUpsert,
		MainGuildID:          lifecycleGuildID,
		DestinationChannelID: lifecycleGeneralID,
		Channel:              lifecycleView(),
		At:                   firstSeen.Add(time.Minute),
	}
	if retry, err := service.deliverUpsert(ctx, intent); err != nil || retry {
		t.Fatalf("deliverUpsert retry/error = %v/%v", retry, err)
	}
	if store.touchChannelID != lifecycleChannelIDUUID {
		t.Errorf("touch ID = %q, want persisted %q", store.touchChannelID, lifecycleChannelIDUUID)
	}

	intent.Kind = IntentEnd
	if retry, err := service.deliverEnd(ctx, intent); err != nil || retry {
		t.Fatalf("deliverEnd retry/error = %v/%v", retry, err)
	}
	if store.deleteChannelID != lifecycleChannelIDUUID {
		t.Errorf("delete ID = %q, want persisted %q", store.deleteChannelID, lifecycleChannelIDUUID)
	}
}

type exactRestoredIDStore struct {
	card            storage.MediaLiveCard
	touchChannelID  string
	deleteChannelID string
}

func (s *exactRestoredIDStore) MediaLiveCards(
	context.Context,
	string,
) ([]storage.MediaLiveCard, error) {
	return []storage.MediaLiveCard{s.card}, nil
}

func (s *exactRestoredIDStore) ClaimMediaLiveCard(
	context.Context,
	string,
	string,
	string,
	time.Time,
) (bool, error) {
	return false, fmt.Errorf("unexpected claim")
}

func (s *exactRestoredIDStore) ReleaseMediaLiveCard(
	context.Context,
	string,
	string,
	string,
) error {
	return fmt.Errorf("unexpected release")
}

func (s *exactRestoredIDStore) ActivateMediaLiveCard(
	context.Context,
	string,
	string,
	string,
	string,
	time.Time,
) error {
	return fmt.Errorf("unexpected activation")
}

func (s *exactRestoredIDStore) TouchMediaLiveCard(
	_ context.Context,
	_ string,
	jellyfinChannelID string,
	_ string,
	_ time.Time,
) error {
	s.touchChannelID = jellyfinChannelID
	if jellyfinChannelID != s.card.JellyfinChannelID {
		return fmt.Errorf("row not found for canonicalized ID")
	}
	return nil
}

func (s *exactRestoredIDStore) DeleteMediaLiveCard(
	_ context.Context,
	_ string,
	jellyfinChannelID string,
) error {
	s.deleteChannelID = jellyfinChannelID
	if jellyfinChannelID != s.card.JellyfinChannelID {
		return fmt.Errorf("row not found for canonicalized ID")
	}
	return nil
}
