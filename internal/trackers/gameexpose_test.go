package trackers

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
)

type recordedPlaytime struct {
	guildID string
	userID  string
	game    string
	seconds int64
}

type fakeGameExposeStore struct {
	mu       sync.Mutex
	failures int
	records  []recordedPlaytime
}

func (f *fakeGameExposeStore) RecordPlaytime(_ context.Context, guildID, userID, _ string, gameName string, seconds int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failures > 0 {
		f.failures--
		return errors.New("temporary database failure")
	}
	f.records = append(f.records, recordedPlaytime{
		guildID: guildID,
		userID:  userID,
		game:    gameName,
		seconds: seconds,
	})
	return nil
}

func (f *fakeGameExposeStore) GuildProfile(context.Context, string) (*storage.GuildProfile, error) {
	return &storage.GuildProfile{}, nil
}

func (f *fakeGameExposeStore) totalSeconds() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	var total int64
	for _, record := range f.records {
		total += record.seconds
	}
	return total
}

func testExpose(store *fakeGameExposeStore) *GameExpose {
	tracker := NewGameExpose(store)
	tracker.checkpointInterval = time.Hour
	tracker.reorderWindow = time.Millisecond
	return tracker
}

func playingPresence(guildID, userID, game string, start int64) presenceSnapshot {
	return presenceSnapshot{
		guildID:  guildID,
		userID:   userID,
		username: "player",
		activities: []gameActivity{{
			name:           game,
			startTimestamp: start,
		}},
	}
}

func TestSnapshotPresenceTracksOnlyGamesWithoutRequiringTimestamp(t *testing.T) {
	presence := &discordgo.Presence{
		User: &discordgo.User{ID: "user", Username: "player"},
		Activities: []*discordgo.Activity{
			{Name: "No Timestamp Game", Type: discordgo.ActivityTypeGame},
			{Name: "Spotify", Type: discordgo.ActivityTypeListening, Timestamps: discordgo.TimeStamps{StartTimestamp: 123}},
			{Name: "A Stream", Type: discordgo.ActivityTypeStreaming, Timestamps: discordgo.TimeStamps{StartTimestamp: 456}},
		},
	}

	snapshot, ok := snapshotPresence(nil, "guild", presence)
	if !ok {
		t.Fatal("snapshotPresence rejected a valid human presence")
	}
	if len(snapshot.activities) != 1 || snapshot.activities[0].name != "No Timestamp Game" {
		t.Fatalf("tracked activities = %#v, want only the Playing activity", snapshot.activities)
	}
}

func TestSessionsAreGuildScoped(t *testing.T) {
	store := &fakeGameExposeStore{}
	tracker := testExpose(store)
	start := time.Unix(1_700_000_000, 0)

	tracker.applyPresence(playingPresence("guild-a", "user", "Game", 1), start)
	tracker.applyPresence(playingPresence("guild-b", "user", "Game", 1), start)
	if len(tracker.sessions) != 2 {
		t.Fatalf("active sessions = %d, want 2", len(tracker.sessions))
	}

	tracker.applyPresence(presenceSnapshot{guildID: "guild-a", userID: "user", username: "player"}, start.Add(2*time.Minute))
	if len(tracker.sessions) != 1 {
		t.Fatalf("active sessions after guild-a stop = %d, want guild-b to remain", len(tracker.sessions))
	}
	tracker.persistPending(context.Background(), nil)

	if len(store.records) != 1 || store.records[0].guildID != "guild-a" || store.records[0].seconds != 120 {
		t.Fatalf("records = %#v, want a 120-second guild-a record", store.records)
	}
}

func TestChangedStartTimestampSplitsSameNamedGame(t *testing.T) {
	store := &fakeGameExposeStore{}
	tracker := testExpose(store)
	start := time.Unix(1_700_000_000, 0)

	tracker.applyPresence(playingPresence("guild", "user", "Game", 100), start)
	tracker.applyPresence(playingPresence("guild", "user", "Game", 200), start.Add(2*time.Minute))

	if len(tracker.sessions) != 1 || len(tracker.endedSessions) != 1 {
		t.Fatalf("active=%d ended=%d, want one new and one ended session", len(tracker.sessions), len(tracker.endedSessions))
	}
	tracker.persistPending(context.Background(), nil)
	if store.totalSeconds() != 120 {
		t.Fatalf("persisted seconds = %d, want 120", store.totalSeconds())
	}
}

func TestCheckpointAndStopPersistEachSecondOnce(t *testing.T) {
	store := &fakeGameExposeStore{}
	tracker := testExpose(store)
	start := time.Unix(1_700_000_000, 0)

	tracker.applyPresence(playingPresence("guild", "user", "Game", 1), start)
	tracker.checkpointActive(start.Add(90 * time.Second))
	tracker.persistPending(context.Background(), nil)
	tracker.applyPresence(presenceSnapshot{guildID: "guild", userID: "user", username: "player"}, start.Add(150*time.Second))
	tracker.persistPending(context.Background(), nil)

	if store.totalSeconds() != 150 {
		t.Fatalf("persisted seconds = %d, want 150", store.totalSeconds())
	}
	if len(tracker.endedSessions) != 0 {
		t.Fatalf("ended sessions retained after success = %d, want 0", len(tracker.endedSessions))
	}
}

func TestFailedWriteIsRetriedBeforeSessionRemoval(t *testing.T) {
	store := &fakeGameExposeStore{failures: 1}
	tracker := testExpose(store)
	start := time.Unix(1_700_000_000, 0)

	tracker.applyPresence(playingPresence("guild", "user", "Game", 1), start)
	tracker.applyPresence(presenceSnapshot{guildID: "guild", userID: "user", username: "player"}, start.Add(2*time.Minute))
	tracker.persistPending(context.Background(), nil)

	if len(tracker.endedSessions) != 1 || store.totalSeconds() != 0 {
		t.Fatalf("after failure: ended=%d seconds=%d, want retained session and no credit", len(tracker.endedSessions), store.totalSeconds())
	}

	tracker.persistPending(context.Background(), nil)
	if len(tracker.endedSessions) != 0 || store.totalSeconds() != 120 {
		t.Fatalf("after retry: ended=%d seconds=%d, want removal and 120 seconds", len(tracker.endedSessions), store.totalSeconds())
	}
}

func TestRunReordersConsecutiveGatewayEventsBySequence(t *testing.T) {
	store := &fakeGameExposeStore{}
	tracker := testExpose(store)
	fixed := time.Unix(1_700_000_000, 0)
	tracker.now = func() time.Time { return fixed }

	ctx, cancel := context.WithCancel(context.Background())
	go tracker.Run(ctx, nil)

	// Deliberately enqueue the stop first. Sequence order must still apply the
	// start before the stop, leaving no stale active session.
	tracker.enqueue(gameTrackerEvent{
		kind:     gameGatewayEvent,
		sequence: 20,
		presences: []presenceSnapshot{{
			guildID: "guild", userID: "user", username: "player",
		}},
	})
	tracker.enqueue(gameTrackerEvent{
		kind:      gameGatewayEvent,
		sequence:  10,
		presences: []presenceSnapshot{playingPresence("guild", "user", "Game", 1)},
	})

	time.Sleep(20 * time.Millisecond)
	cancel()
	<-tracker.Done()

	if len(tracker.sessions) != 0 {
		t.Fatalf("active sessions = %d, want 0 after ordered start/stop", len(tracker.sessions))
	}
}
