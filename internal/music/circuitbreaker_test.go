package music

import (
	"io"
	"log/slog"
	"testing"
)

// testLogger discards output so failing-path tests stay quiet.
func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// The circuit breaker is what stops a broken source (e.g. YouTube rotating its
// player script) from burning a whole queue in seconds — the 2026-08-23
// incident where a 12-track playlist produced 12 "Now playing" cards and no
// audio.
func TestRecordTrackFailureTripsAfterThreshold(t *testing.T) {
	m := &Manager{log: testLogger(), guilds: map[string]*GuildPlayer{}}
	gp := m.Guild("g1")
	gp.Queue = []*Track{{Title: "b"}, {Title: "c"}}
	gp.Current = &Track{Title: "a"}
	gp.lastFailure = "Must find sig function from script: base.js"

	for i := 1; i < maxConsecutiveFailures; i++ {
		if tripped := m.recordTrackFailure(gp); tripped {
			t.Fatalf("tripped early at failure %d", i)
		}
	}
	if !m.recordTrackFailure(gp) {
		t.Fatalf("did not trip at %d failures", maxConsecutiveFailures)
	}

	gp.mu.Lock()
	defer gp.mu.Unlock()
	if len(gp.Queue) != 0 || gp.Current != nil {
		t.Errorf("queue not cleared on trip: %d queued, current=%v", len(gp.Queue), gp.Current)
	}
	if gp.consecutiveFailures != 0 {
		t.Errorf("counter not reset after trip: %d", gp.consecutiveFailures)
	}
}

// A track that plays through resets the count, so occasional duds spread over a
// long session never accumulate into a trip.
func TestRecordTrackFailureResetsOnSuccess(t *testing.T) {
	m := &Manager{log: testLogger(), guilds: map[string]*GuildPlayer{}}
	gp := m.Guild("g1")

	if m.recordTrackFailure(gp) {
		t.Fatal("tripped on the first failure")
	}
	gp.mu.Lock()
	gp.consecutiveFailures = 0 // as onTrackEnd(finished) does
	gp.mu.Unlock()

	for i := 1; i < maxConsecutiveFailures; i++ {
		if m.recordTrackFailure(gp) {
			t.Fatalf("tripped early after reset at %d", i)
		}
	}
}
