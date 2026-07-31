package jobs

import "testing"

func TestMCTrackerBaselineIsSilent(t *testing.T) {
	// A bot restart while the server is up must not announce anything.
	tr := newMCTracker(3)
	state, changed := tr.observe(true)
	if state != mcUp {
		t.Errorf("state = %v, want mcUp", state)
	}
	if changed {
		t.Error("first successful observation should not report a change")
	}

	// Still up: no repeat announcements.
	if _, changed := tr.observe(true); changed {
		t.Error("staying up should not report a change")
	}
}

func TestMCTrackerRequiresThresholdBeforeDown(t *testing.T) {
	tr := newMCTracker(3)
	tr.observe(true) // baseline: up

	for i := 1; i < 3; i++ {
		state, changed := tr.observe(false)
		if changed {
			t.Fatalf("failure %d announced down before threshold", i)
		}
		if state != mcUp {
			t.Fatalf("failure %d: state = %v, want still mcUp", i, state)
		}
	}

	state, changed := tr.observe(false)
	if !changed || state != mcDown {
		t.Fatalf("third failure: state=%v changed=%v, want mcDown/true", state, changed)
	}

	// Already down: stay quiet.
	if _, changed := tr.observe(false); changed {
		t.Error("staying down should not report a change")
	}
}

func TestMCTrackerRecoversImmediately(t *testing.T) {
	tr := newMCTracker(3)
	tr.observe(true)
	for i := 0; i < 3; i++ {
		tr.observe(false)
	}

	// Recovery needs no threshold — one good ping is proof enough.
	state, changed := tr.observe(true)
	if !changed || state != mcUp {
		t.Fatalf("recovery: state=%v changed=%v, want mcUp/true", state, changed)
	}
}

func TestMCTrackerTransientFailureResetsCounter(t *testing.T) {
	// Two failures then a success must not leave the tracker one failure away
	// from announcing down — this is the whole point of the debounce.
	tr := newMCTracker(3)
	tr.observe(true)
	tr.observe(false)
	tr.observe(false)
	if _, changed := tr.observe(true); changed {
		t.Error("recovering before the threshold should be silent")
	}

	for i := 1; i < 3; i++ {
		if _, changed := tr.observe(false); changed {
			t.Fatalf("failure %d after reset announced too early", i)
		}
	}
	if _, changed := tr.observe(false); !changed {
		t.Error("counter did not reset: expected down on the third fresh failure")
	}
}

func TestMCTrackerStartingDownIsSilent(t *testing.T) {
	// Bot starts while the server is already down: establish the baseline
	// quietly, then announce only when it comes back.
	tr := newMCTracker(3)
	for i := 0; i < 3; i++ {
		if _, changed := tr.observe(false); changed {
			t.Fatalf("observation %d announced a change from unknown", i)
		}
	}
	state, changed := tr.observe(true)
	if !changed || state != mcUp {
		t.Fatalf("recovery from initial-down: state=%v changed=%v, want mcUp/true", state, changed)
	}
}

func TestNewMCTrackerClampsThreshold(t *testing.T) {
	tr := newMCTracker(0)
	if tr.threshold != 1 {
		t.Errorf("threshold = %d, want clamped to 1", tr.threshold)
	}
	tr.observe(true)
	if _, changed := tr.observe(false); !changed {
		t.Error("threshold 1 should announce down on the first failure")
	}
}

func TestPlayerTrackerBaselineIsSilent(t *testing.T) {
	pt := newPlayerTracker()
	joined, left := pt.observe([]string{"OlliePCK", "Mr___Ed"})
	if len(joined) != 0 || len(left) != 0 {
		t.Errorf("baseline should be silent, got joined=%v left=%v", joined, left)
	}
}

func TestPlayerTrackerDiffs(t *testing.T) {
	pt := newPlayerTracker()
	pt.observe([]string{"OlliePCK"})

	joined, left := pt.observe([]string{"OlliePCK", "Mr___Ed"})
	if len(joined) != 1 || joined[0] != "Mr___Ed" || len(left) != 0 {
		t.Errorf("joined=%v left=%v, want Mr___Ed joined", joined, left)
	}

	joined, left = pt.observe([]string{"Mr___Ed"})
	if len(left) != 1 || left[0] != "OlliePCK" || len(joined) != 0 {
		t.Errorf("joined=%v left=%v, want OlliePCK left", joined, left)
	}

	if j, l := pt.observe([]string{"Mr___Ed"}); len(j) != 0 || len(l) != 0 {
		t.Errorf("no change should be silent, got %v %v", j, l)
	}
}

func TestPlayerTrackerResetReSeedsSilently(t *testing.T) {
	// After a downtime the whole roster must not be announced as fresh joins.
	pt := newPlayerTracker()
	pt.observe([]string{"OlliePCK", "Mr___Ed"})
	pt.reset()
	joined, left := pt.observe([]string{"OlliePCK", "Mr___Ed", "Winter"})
	if len(joined) != 0 || len(left) != 0 {
		t.Errorf("post-reset observation should re-seed silently, got %v %v", joined, left)
	}
	if j, _ := pt.observe([]string{"OlliePCK", "Mr___Ed", "Winter", "Sen"}); len(j) != 1 || j[0] != "Sen" {
		t.Errorf("diffing should resume after re-seed, got %v", j)
	}
}

func TestPlayerTrackerIgnoresBlanks(t *testing.T) {
	pt := newPlayerTracker()
	pt.observe([]string{"OlliePCK"})
	if j, l := pt.observe([]string{"OlliePCK", "", "   "}); len(j) != 0 || len(l) != 0 {
		t.Errorf("blank names should be ignored, got %v %v", j, l)
	}
}

func TestPlayerTrackerSortsOutput(t *testing.T) {
	pt := newPlayerTracker()
	pt.observe(nil)
	joined, _ := pt.observe([]string{"Winter", "Chaz", "Sen"})
	if len(joined) != 3 || joined[0] != "Chaz" || joined[2] != "Winter" {
		t.Errorf("joined not sorted deterministically: %v", joined)
	}
}
