package bot

import (
	"testing"
	"time"

	"github.com/bwmarrin/discordgo"
)

// A session that has never connected must not look like an outage — the
// initial connect belongs to Run(), and the watchdog firing during startup
// would re-IDENTIFY needlessly.
func TestHeartbeatAgeBeforeFirstAck(t *testing.T) {
	s := &discordgo.Session{}
	if _, ok := HeartbeatAge(s); ok {
		t.Error("reported an ack age before the first heartbeat")
	}
	if !GatewayHealthy(s) {
		t.Error("a session that never connected was reported unhealthy")
	}
}

// The wedge this guards against freezes LastHeartbeatAck: discordgo's
// heartbeat goroutine returns and the timestamp simply stops advancing while
// the process keeps looking healthy (2026-09-14, four days offline).
func TestGatewayHealthyTracksAckAge(t *testing.T) {
	for _, tc := range []struct {
		name    string
		age     time.Duration
		healthy bool
	}{
		{"just acked", 0, true},
		{"one missed beat", 45 * time.Second, true},
		{"just inside the window", GatewayStaleAfter - time.Second, true},
		{"just past the window", GatewayStaleAfter + time.Second, false},
		{"wedged for days", 96 * time.Hour, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &discordgo.Session{}
			s.LastHeartbeatAck = time.Now().UTC().Add(-tc.age)
			if got := GatewayHealthy(s); got != tc.healthy {
				t.Errorf("GatewayHealthy() = %v, want %v (ack %v old)", got, tc.healthy, tc.age)
			}
		})
	}
}

// Each recovery attempt costs an IDENTIFY against a 1000/day budget, so
// repeated failures have to spread out rather than retry every tick.
func TestRecoveryBackoffGrowsAndCaps(t *testing.T) {
	want := []time.Duration{
		time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute,
		maxRecoveryBackoff, maxRecoveryBackoff,
	}
	for i, w := range want {
		if got := recoveryBackoff(i + 1); got != w {
			t.Errorf("recoveryBackoff(%d) = %v, want %v", i+1, got, w)
		}
	}
	// Defensive: a zero or negative count must still produce a usable wait
	// rather than a negative shift.
	if got := recoveryBackoff(0); got != time.Minute {
		t.Errorf("recoveryBackoff(0) = %v, want %v", got, time.Minute)
	}
	if got := recoveryBackoff(64); got != maxRecoveryBackoff {
		t.Errorf("recoveryBackoff(64) = %v, want %v", got, maxRecoveryBackoff)
	}
}
