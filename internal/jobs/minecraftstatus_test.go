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
