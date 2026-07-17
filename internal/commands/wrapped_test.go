package commands

import "testing"

func TestCompatibility(t *testing.T) {
	tests := []struct {
		name        string
		a, b        []string
		wantPercent int
		wantShared  int
	}{
		{
			name: "identical taste",
			a:    []string{"Yeat", "Drake"}, b: []string{"yeat", "drake"},
			wantPercent: 100, wantShared: 2,
		},
		{
			name: "no overlap",
			a:    []string{"Yeat"}, b: []string{"Mozart"},
			wantPercent: 0, wantShared: 0,
		},
		{
			name: "half overlap against smaller set",
			a:    []string{"A", "B", "C", "D"}, b: []string{"a", "x"},
			wantPercent: 50, wantShared: 1,
		},
		{
			name: "empty side",
			a:    []string{}, b: []string{"A"},
			wantPercent: 0, wantShared: 0,
		},
		{
			name: "case-insensitive dedupe",
			a:    []string{"AC/DC", "ac/dc"}, b: []string{"Ac/Dc"},
			wantPercent: 100, wantShared: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			percent, shared := compatibility(tt.a, tt.b)
			if percent != tt.wantPercent {
				t.Errorf("percent = %d, want %d", percent, tt.wantPercent)
			}
			if len(shared) != tt.wantShared {
				t.Errorf("shared = %v (len %d), want len %d", shared, len(shared), tt.wantShared)
			}
		})
	}
}

func TestCompatEmoji(t *testing.T) {
	tests := []struct {
		percent int
		want    string
	}{
		{100, "❤️‍🔥"}, {80, "❤️‍🔥"}, {79, "💖"}, {60, "💖"},
		{59, "💛"}, {40, "💛"}, {39, "💙"}, {20, "💙"}, {19, "💔"}, {0, "💔"},
	}
	for _, tt := range tests {
		if got := compatEmoji(tt.percent); got != tt.want {
			t.Errorf("compatEmoji(%d) = %q, want %q", tt.percent, got, tt.want)
		}
	}
}
