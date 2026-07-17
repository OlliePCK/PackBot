package commands

import (
	"strings"
	"testing"
)

func TestPollResultsText(t *testing.T) {
	tests := []struct {
		name     string
		options  []string
		votes    map[string][]string
		contains []string
	}{
		{
			name:    "no votes",
			options: []string{"Yes", "No"},
			votes:   map[string][]string{"0": {}, "1": {}},
			contains: []string{
				"**1.** Yes", "**2.** No",
				"░░░░░░░░░░ 0 votes (0%)",
			},
		},
		{
			name:    "unanimous",
			options: []string{"Yes", "No"},
			votes:   map[string][]string{"0": {"u1", "u2"}, "1": {}},
			contains: []string{
				"██████████ 2 votes (100%)",
				"░░░░░░░░░░ 0 votes (0%)",
			},
		},
		{
			name:    "split vote singular",
			options: []string{"A", "B"},
			votes:   map[string][]string{"0": {"u1"}, "1": {"u2"}},
			contains: []string{
				"█████░░░░░ 1 vote (50%)",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := pollResultsText(tt.options, tt.votes)
			for _, want := range tt.contains {
				if !strings.Contains(got, want) {
					t.Errorf("result missing %q:\n%s", want, got)
				}
			}
		})
	}
}

func TestPollWinners(t *testing.T) {
	tests := []struct {
		name    string
		options []string
		votes   map[string][]string
		want    []string
	}{
		{
			name:    "clear winner",
			options: []string{"A", "B"},
			votes:   map[string][]string{"0": {"u1", "u2"}, "1": {"u3"}},
			want:    []string{"A"},
		},
		{
			name:    "tie returns both",
			options: []string{"A", "B", "C"},
			votes:   map[string][]string{"0": {"u1"}, "1": {"u2"}, "2": {}},
			want:    []string{"A", "B"},
		},
		{
			name:    "no votes no winner",
			options: []string{"A", "B"},
			votes:   map[string][]string{"0": {}, "1": {}},
			want:    nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := pollWinners(tt.options, tt.votes)
			if len(got) != len(tt.want) {
				t.Fatalf("winners = %v, want %v", got, tt.want)
			}
			for idx := range got {
				if got[idx] != tt.want[idx] {
					t.Errorf("winners = %v, want %v", got, tt.want)
				}
			}
		})
	}
}
