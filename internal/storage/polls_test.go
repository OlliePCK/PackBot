package storage

import (
	"reflect"
	"testing"
)

func TestApplyVote(t *testing.T) {
	tests := []struct {
		name   string
		votes  map[string][]string
		userID string
		option int
		want   map[string][]string
	}{
		{
			name:   "first vote",
			votes:  map[string][]string{"0": {}, "1": {}},
			userID: "u1",
			option: 0,
			want:   map[string][]string{"0": {"u1"}, "1": {}},
		},
		{
			name:   "revote moves the vote",
			votes:  map[string][]string{"0": {"u1"}, "1": {}},
			userID: "u1",
			option: 1,
			want:   map[string][]string{"0": {}, "1": {"u1"}},
		},
		{
			name:   "same option again stays single",
			votes:  map[string][]string{"0": {"u1"}, "1": {}},
			userID: "u1",
			option: 0,
			want:   map[string][]string{"0": {"u1"}, "1": {}},
		},
		{
			name:   "does not disturb other voters",
			votes:  map[string][]string{"0": {"u1", "u2"}, "1": {"u3"}},
			userID: "u2",
			option: 1,
			want:   map[string][]string{"0": {"u1"}, "1": {"u3", "u2"}},
		},
		{
			name:   "vote for option with no existing key",
			votes:  map[string][]string{"0": {}},
			userID: "u1",
			option: 2,
			want:   map[string][]string{"0": {}, "2": {"u1"}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ApplyVote(tt.votes, tt.userID, tt.option)
			// Normalize: reflect.DeepEqual treats nil and empty slices as
			// different, but for vote semantics they are the same.
			for k, v := range tt.votes {
				if len(v) == 0 {
					tt.votes[k] = []string{}
				}
			}
			for k, v := range tt.want {
				if len(v) == 0 {
					tt.want[k] = []string{}
				}
			}
			if !reflect.DeepEqual(tt.votes, tt.want) {
				t.Errorf("votes = %v, want %v", tt.votes, tt.want)
			}
		})
	}
}
