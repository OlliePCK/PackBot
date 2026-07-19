package media

import (
	"reflect"
	"testing"
	"time"
)

func TestReconcilerSeedsExistingLifecycle(t *testing.T) {
	r := newTestReconciler(t, 2, 2, AnonymizeUnknownViewers)
	now := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)
	session := liveSession("viewer-ollie", "fox-503", "game-1", "Sydney v Adelaide")

	assertNoIntents(t, r.Reconcile(now, []LiveTVSession{session}))
	assertNoIntents(t, r.Reconcile(now.Add(15*time.Second), []LiveTVSession{session}))
	assertNoIntents(t, r.Reconcile(now.Add(30*time.Second), nil))
	assertNoIntents(t, r.Reconcile(now.Add(45*time.Second), nil))

	// Once the startup lifecycle has ended, the same channel may start a new,
	// confirmable lifecycle.
	assertNoIntents(t, r.Reconcile(now.Add(60*time.Second), []LiveTVSession{session}))
	intents := r.Reconcile(now.Add(75*time.Second), []LiveTVSession{session})
	if len(intents) != 1 || intents[0].Kind != IntentUpsert {
		t.Fatalf("intents = %#v, want one upsert", intents)
	}
	if !intents[0].Channel.StartedAt.Equal(now.Add(60 * time.Second)) {
		t.Errorf("StartedAt = %v, want first observation", intents[0].Channel.StartedAt)
	}
}

func TestReconcilerAggregatesAndSanitizesViewers(t *testing.T) {
	r := newTestReconciler(t, 2, 2, AnonymizeUnknownViewers)
	now := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)
	assertNoIntents(t, r.Reconcile(now, nil))

	sessions := []LiveTVSession{
		liveSession("unknown-b", "fox-503", "game-1", "Sydney v Adelaide"),
		liveSession("viewer-ollie", "fox-503", "game-1", "Sydney v Adelaide"),
		liveSession("unknown-a", "fox-503", "game-1", "Sydney v Adelaide"),
		// A second client belonging to Ollie must not inflate the viewer count.
		liveSession("viewer-ollie", "fox-503", "game-1", "Sydney v Adelaide"),
		// Provider-facing channel names are never used in the public view.
		{
			ViewerID: "viewer-ollie", ChannelID: "fox-503",
			ChannelName: "AU: rotating provider event", ProgramID: "game-1",
			ProgramName: "Sydney v Adelaide",
		},
	}
	assertNoIntents(t, r.Reconcile(now.Add(15*time.Second), sessions))
	intents := r.Reconcile(now.Add(30*time.Second), reverseSessions(sessions))
	if len(intents) != 1 {
		t.Fatalf("got %d intents, want 1: %#v", len(intents), intents)
	}
	got := intents[0]
	if got.MainGuildID != "friends-guild" || got.DestinationChannelID != "general-channel" {
		t.Errorf("destination = %q/%q", got.MainGuildID, got.DestinationChannelID)
	}
	if got.Channel.ChannelName != "Fox Sports 503" {
		t.Errorf("channel name = %q", got.Channel.ChannelName)
	}
	wantViewers := []string{"Ollie", "Someone", "Someone"}
	if !reflect.DeepEqual(got.Channel.Viewers, wantViewers) {
		t.Errorf("viewers = %#v, want %#v", got.Channel.Viewers, wantViewers)
	}
	if got.Channel.WatchURL != "https://jellyfin.example/web/#/details?id=fox-503" {
		t.Errorf("watch URL = %q", got.Channel.WatchURL)
	}
}

func TestReconcilerRequiresConsecutiveConfirmation(t *testing.T) {
	r := newTestReconciler(t, 2, 2, AnonymizeUnknownViewers)
	now := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)
	session := liveSession("viewer-ollie", "fox-503", "game-1", "Sydney v Adelaide")
	assertNoIntents(t, r.Reconcile(now, nil))
	assertNoIntents(t, r.Reconcile(now.Add(15*time.Second), []LiveTVSession{session}))
	assertNoIntents(t, r.Reconcile(now.Add(30*time.Second), nil))
	assertNoIntents(t, r.Reconcile(now.Add(45*time.Second), []LiveTVSession{session}))

	intents := r.Reconcile(now.Add(60*time.Second), []LiveTVSession{session})
	if len(intents) != 1 || intents[0].Kind != IntentUpsert {
		t.Fatalf("intents = %#v, want confirmed upsert", intents)
	}
}

func TestReconcilerEmitsDeterministicEndThenUpsert(t *testing.T) {
	r := newTestReconciler(t, 2, 1, AnonymizeUnknownViewers)
	now := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)
	assertNoIntents(t, r.Reconcile(now, nil))

	first := []LiveTVSession{
		liveSession("viewer-ollie", "seven", "news", "Seven News"),
		liveSession("viewer-ollie", "fox-503", "game-1", "Sydney v Adelaide"),
	}
	assertNoIntents(t, r.Reconcile(now.Add(15*time.Second), first))
	upserts := r.Reconcile(now.Add(30*time.Second), reverseSessions(first))
	if len(upserts) != 2 || upserts[0].Kind != IntentUpsert || upserts[0].Channel.ChannelID != "fox-503" ||
		upserts[1].Channel.ChannelID != "seven" {
		t.Fatalf("initial intents are not deterministic: %#v", upserts)
	}

	changed := []LiveTVSession{
		liveSession("viewer-ollie", "seven", "game-2", "Gold Coast v Bulldogs"),
		liveSession("viewer-friend", "seven", "game-2", "Gold Coast v Bulldogs"),
	}
	intents := r.Reconcile(now.Add(45*time.Second), changed)
	if len(intents) != 2 {
		t.Fatalf("got %d intents, want end and upsert: %#v", len(intents), intents)
	}
	if intents[0].Kind != IntentEnd || intents[0].Channel.ChannelID != "fox-503" {
		t.Errorf("first intent = %#v, want fox-503 end", intents[0])
	}
	if intents[1].Kind != IntentUpsert || intents[1].Channel.ChannelID != "seven" {
		t.Errorf("second intent = %#v, want seven upsert", intents[1])
	}
	if want := []string{"Friend", "Ollie"}; !reflect.DeepEqual(intents[1].Channel.Viewers, want) {
		t.Errorf("changed viewers = %#v, want %#v", intents[1].Channel.Viewers, want)
	}
}

func TestReconcilerIgnoresUnallowlistedInputs(t *testing.T) {
	r := newTestReconciler(t, 2, 1, IgnoreUnknownViewers)
	now := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)
	assertNoIntents(t, r.Reconcile(now, nil))

	sessions := []LiveTVSession{
		liveSession("viewer-ollie", "provider-event-99", "event", "Private event"),
		liveSession("unknown-user", "fox-503", "game", "Sydney v Adelaide"),
	}
	assertNoIntents(t, r.Reconcile(now.Add(15*time.Second), sessions))
	assertNoIntents(t, r.Reconcile(now.Add(30*time.Second), sessions))
}

func TestReconcilerConfigIsValidatedAndCopied(t *testing.T) {
	cfg := testConfig(2, 2, AnonymizeUnknownViewers)
	r, err := NewReconciler(cfg)
	if err != nil {
		t.Fatalf("NewReconciler: %v", err)
	}
	// Mutating the caller's maps must not expand or rename the allowlists.
	cfg.ViewerAliases["viewer-ollie"] = "Leaked Login Name"
	cfg.Channels["fox-503"] = ChannelConfig{
		DisplayName: "Mutated Provider Name",
		WatchURL:    "https://attacker.example/",
	}

	now := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)
	assertNoIntents(t, r.Reconcile(now, nil))
	session := liveSession("viewer-ollie", "fox-503", "game", "AFL")
	assertNoIntents(t, r.Reconcile(now.Add(15*time.Second), []LiveTVSession{session}))
	intents := r.Reconcile(now.Add(30*time.Second), []LiveTVSession{session})
	if got := intents[0].Channel.ChannelName; got != "Fox Sports 503" {
		t.Errorf("copied channel name = %q", got)
	}
	if got := intents[0].Channel.Viewers; !reflect.DeepEqual(got, []string{"Ollie"}) {
		t.Errorf("copied aliases = %#v", got)
	}

	bad := testConfig(1, 2, AnonymizeUnknownViewers)
	if _, err := NewReconciler(bad); err == nil {
		t.Error("expected confirmation validation error")
	}
	bad = testConfig(2, 2, AnonymizeUnknownViewers)
	bad.Channels["fox-503"] = ChannelConfig{DisplayName: "Fox", WatchURL: "https://jellyfin.example/?api_key=secret"}
	if _, err := NewReconciler(bad); err == nil {
		t.Error("expected token-bearing watch URL validation error")
	}
}

func newTestReconciler(t *testing.T, confirmation, missing int, policy UnknownViewerPolicy) *Reconciler {
	t.Helper()
	r, err := NewReconciler(testConfig(confirmation, missing, policy))
	if err != nil {
		t.Fatalf("NewReconciler: %v", err)
	}
	return r
}

func testConfig(confirmation, missing int, policy UnknownViewerPolicy) Config {
	return Config{
		MainGuildID:          "friends-guild",
		GeneralChannelID:     "general-channel",
		ConfirmationPolls:    confirmation,
		EndAfterMissingPolls: missing,
		UnknownViewerPolicy:  policy,
		ViewerAliases: map[string]string{
			"viewer-ollie":  "Ollie",
			"viewer-friend": "Friend",
		},
		Channels: map[string]ChannelConfig{
			"fox-503": {
				DisplayName: "Fox Sports 503",
				WatchURL:    "https://jellyfin.example/web/#/details?id=fox-503",
			},
			"seven": {
				DisplayName: "Seven Melbourne",
				WatchURL:    "https://jellyfin.example/web/#/details?id=seven",
			},
		},
	}
}

func liveSession(viewerID, channelID, programID, programName string) LiveTVSession {
	return LiveTVSession{
		ViewerID:    viewerID,
		ChannelID:   channelID,
		ChannelName: "untrusted provider name",
		ProgramID:   programID,
		ProgramName: programName,
	}
}

func reverseSessions(in []LiveTVSession) []LiveTVSession {
	out := append([]LiveTVSession(nil), in...)
	for left, right := 0, len(out)-1; left < right; left, right = left+1, right-1 {
		out[left], out[right] = out[right], out[left]
	}
	return out
}

func assertNoIntents(t *testing.T, intents []Intent) {
	t.Helper()
	if len(intents) != 0 {
		t.Fatalf("got intents, want none: %#v", intents)
	}
}
