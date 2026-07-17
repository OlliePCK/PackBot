package jobs

import "testing"

func TestNextSkips(t *testing.T) {
	tests := []struct {
		missCount int
		maxMult   int
		want      int
	}{
		// 2^miss capped at maxMult, minus the cycle just spent checking.
		{0, 8, 0},  // fresh hit: no skips
		{1, 8, 1},  // one miss: skip 1 cycle (check hourly)
		{2, 8, 3},  // skip 3 (every 2h)
		{3, 8, 7},  // skip 7 (every 4h) — at cap
		{4, 8, 7},  // capped
		{10, 8, 7}, // capped
		{3, 4, 3},  // lower cap
		{1, 1, 0},  // multiplier 1 disables backoff
	}
	for _, tt := range tests {
		if got := nextSkips(tt.missCount, tt.maxMult); got != tt.want {
			t.Errorf("nextSkips(%d, %d) = %d, want %d", tt.missCount, tt.maxMult, got, tt.want)
		}
	}
}
