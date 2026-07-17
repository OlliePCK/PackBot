package commands

import "testing"

func TestFormatPlaytime(t *testing.T) {
	tests := []struct {
		seconds int64
		want    string
	}{
		{0, "0h 0m"},
		{59, "0h 0m"},
		{60, "0h 1m"},
		{3600, "1h 0m"},
		{3660, "1h 1m"},
		{86399, "23h 59m"},
		{86400, "1d 0h 0m"},
		{90000, "1d 1h 0m"},
		{266460, "3d 2h 1m"},
	}
	for _, tt := range tests {
		if got := formatPlaytime(tt.seconds); got != tt.want {
			t.Errorf("formatPlaytime(%d) = %q, want %q", tt.seconds, got, tt.want)
		}
	}
}

func TestMedal(t *testing.T) {
	tests := []struct {
		index int
		want  string
	}{
		{0, "🥇"},
		{1, "🥈"},
		{2, "🥉"},
		{3, "**4.**"},
		{9, "**10.**"},
	}
	for _, tt := range tests {
		if got := medal(tt.index); got != tt.want {
			t.Errorf("medal(%d) = %q, want %q", tt.index, got, tt.want)
		}
	}
}

func TestFormatHour(t *testing.T) {
	tests := []struct {
		hour int
		want string
	}{
		{0, "12 AM"},
		{1, "1 AM"},
		{11, "11 AM"},
		{12, "12 PM"},
		{13, "1 PM"},
		{23, "11 PM"},
	}
	for _, tt := range tests {
		if got := formatHour(tt.hour); got != tt.want {
			t.Errorf("formatHour(%d) = %q, want %q", tt.hour, got, tt.want)
		}
	}
}
