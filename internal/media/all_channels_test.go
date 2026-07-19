package media

import (
	"testing"
	"time"
)

func allChannelsConfig(t *testing.T) Config {
	t.Helper()
	cfg := testConfig(2, 2, IgnoreUnknownViewers)
	cfg.AllowAllChannels = true
	cfg.PublicBaseURL = "https://jellyfin.example"
	return cfg
}

// In AllowAllChannels mode any active channel is surfaced (the single-
// connection occupancy alert): a non-curated channel takes its display name
// from the Jellyfin session and a generated token-free watch URL, while a
// curated channel keeps its safe curated name.
func TestReconcilerAllChannelsSurfacesUncuratedChannel(t *testing.T) {
	r, err := NewReconciler(allChannelsConfig(t))
	if err != nil {
		t.Fatalf("NewReconciler: %v", err)
	}
	now := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)

	uncurated := LiveTVSession{
		ViewerID: "viewer-ollie", ChannelID: "espn-1",
		ChannelName: "AU: ESPN 1", ProgramID: "np-1", ProgramName: "Some Match",
	}
	assertNoIntents(t, r.Reconcile(now, nil))                                    // startup
	assertNoIntents(t, r.Reconcile(now.Add(15*time.Second), []LiveTVSession{uncurated})) // obs 1
	intents := r.Reconcile(now.Add(30*time.Second), []LiveTVSession{uncurated})          // obs 2 -> publish
	if len(intents) != 1 || intents[0].Kind != IntentUpsert {
		t.Fatalf("intents = %#v, want one upsert", intents)
	}
	got := intents[0].Channel
	if got.ChannelName != "AU: ESPN 1" {
		t.Errorf("channel name = %q, want the session's name in all-channels mode", got.ChannelName)
	}
	if got.WatchURL != "https://jellyfin.example/web/#/details?id=espn-1" {
		t.Errorf("watch URL = %q, want generated from the public base", got.WatchURL)
	}
	if len(got.Viewers) != 1 || got.Viewers[0] != "Ollie" {
		t.Errorf("viewers = %#v, want [Ollie]", got.Viewers)
	}
}

func TestReconcilerAllChannelsKeepsCuratedNames(t *testing.T) {
	r, err := NewReconciler(allChannelsConfig(t))
	if err != nil {
		t.Fatalf("NewReconciler: %v", err)
	}
	now := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)
	// fox-503 IS curated; its safe name must win over the provider session name.
	curated := liveSession("viewer-ollie", "fox-503", "np-1", "Sydney v Adelaide")
	assertNoIntents(t, r.Reconcile(now, nil))
	assertNoIntents(t, r.Reconcile(now.Add(15*time.Second), []LiveTVSession{curated}))
	intents := r.Reconcile(now.Add(30*time.Second), []LiveTVSession{curated})
	if len(intents) != 1 {
		t.Fatalf("intents = %#v, want one", intents)
	}
	if got := intents[0].Channel.ChannelName; got != "Fox Sports 503" {
		t.Errorf("channel name = %q, want curated 'Fox Sports 503'", got)
	}
}

// Unknown viewers are still ignored in all-channels mode: surfacing every
// channel must not start naming people who aren't in the alias allowlist.
func TestReconcilerAllChannelsStillIgnoresUnknownViewers(t *testing.T) {
	r, err := NewReconciler(allChannelsConfig(t))
	if err != nil {
		t.Fatalf("NewReconciler: %v", err)
	}
	now := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)
	stranger := LiveTVSession{ViewerID: "not-in-aliases", ChannelID: "espn-1", ChannelName: "AU: ESPN 1"}
	assertNoIntents(t, r.Reconcile(now, nil))
	assertNoIntents(t, r.Reconcile(now.Add(15*time.Second), []LiveTVSession{stranger}))
	assertNoIntents(t, r.Reconcile(now.Add(30*time.Second), []LiveTVSession{stranger}))
}

func TestNormalizeConfigAllChannels(t *testing.T) {
	base := allChannelsConfig(t)
	base.Channels = nil // no curated channels at all

	if _, err := normalizeConfig(base); err != nil {
		t.Errorf("empty channels with AllowAllChannels should be valid, got %v", err)
	}

	noBase := base
	noBase.PublicBaseURL = ""
	if _, err := normalizeConfig(noBase); err == nil {
		t.Error("AllowAllChannels without a public base URL should error")
	}

	// Allowlist mode with no channels is still rejected.
	strict := testConfig(2, 2, IgnoreUnknownViewers)
	strict.Channels = nil
	if _, err := normalizeConfig(strict); err == nil {
		t.Error("allowlist mode with no channels should still error")
	}
}
