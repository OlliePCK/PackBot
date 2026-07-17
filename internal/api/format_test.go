package api

import (
	"testing"
	"time"
)

func TestFormatUptime(t *testing.T) {
	tests := []struct {
		d    time.Duration
		want string
	}{
		{30 * time.Second, "< 1m"},
		{90 * time.Second, "1m"},
		{time.Hour, "1h"},
		{time.Hour + 5*time.Minute, "1h 5m"},
		{25*time.Hour + 6*time.Minute, "1d 1h 6m"},
		{48 * time.Hour, "2d"},
	}
	for _, tt := range tests {
		if got := formatUptime(tt.d); got != tt.want {
			t.Errorf("formatUptime(%v) = %q, want %q", tt.d, got, tt.want)
		}
	}
}

func TestFormatAPIPlaytime(t *testing.T) {
	tests := []struct {
		seconds int64
		want    string
	}{
		{0, "0m"},
		{59, "0m"},
		{60, "1m"},
		{3600, "1h 0m"},
		{90000, "25h 0m"}, // no day rollover in the API formatter
	}
	for _, tt := range tests {
		if got := formatAPIPlaytime(tt.seconds); got != tt.want {
			t.Errorf("formatAPIPlaytime(%d) = %q, want %q", tt.seconds, got, tt.want)
		}
	}
}
