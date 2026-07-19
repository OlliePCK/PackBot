package media

import (
	"context"
	"testing"
	"time"

	"github.com/OlliePCK/packbot/internal/storage"
)

func TestServicePersistedWrongDestinationRemainsBlocked(t *testing.T) {
	ctx := context.Background()
	firstSeen := time.Date(2026, 7, 19, 5, 0, 0, 0, time.UTC)
	store := newLifecycleStore()
	store.seed(storage.MediaLiveCard{
		GuildID:           lifecycleGuildID,
		JellyfinChannelID: lifecycleChannelID,
		DiscordChannelID:  lifecycleOtherChannel,
		DiscordMessageID:  lifecycleMessageID,
		Status:            storage.MediaCardActive,
		FirstSeenAt:       firstSeen,
		LastSeenAt:        firstSeen,
	})
	source := &lifecycleSource{}
	messenger := &lifecycleMessenger{}
	service := newLifecycleService(t, source, store, messenger)
	if err := service.restore(ctx); err != nil {
		t.Fatalf("restore: %v", err)
	}

	// A new lifecycle may be observed after restart, but the stale row must
	// remain a blocking claim. It is never authority to edit or delete a
	// Discord message outside the configured general channel.
	service.poll(ctx)
	source.sessions = []LiveTVSession{lifecycleSession(lifecycleViewerID)}
	service.poll(ctx)
	service.poll(ctx)
	source.sessions = nil
	service.poll(ctx)
	service.poll(ctx)

	if len(messenger.sends) != 0 || len(messenger.edits) != 0 || len(messenger.deletes) != 0 {
		t.Fatalf(
			"wrong-destination row reached Discord: sends=%d edits=%d deletes=%d",
			len(messenger.sends),
			len(messenger.edits),
			len(messenger.deletes),
		)
	}
	if store.claims != 0 || store.touches != 0 || store.deletions != 0 {
		t.Fatalf(
			"wrong-destination row mutated: claims=%d touches=%d deletions=%d",
			store.claims,
			store.touches,
			store.deletions,
		)
	}
	if card, ok := store.card(lifecycleChannelID); !ok || card.DiscordChannelID != lifecycleOtherChannel {
		t.Fatalf("blocking row was not retained: %#v, present=%v", card, ok)
	}
}
