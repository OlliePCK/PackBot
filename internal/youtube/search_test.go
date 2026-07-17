package youtube

import (
	"testing"
	"time"
)

func TestParseISODuration(t *testing.T) {
	tests := []struct {
		iso  string
		want int
	}{
		{"PT3M18S", 198},
		{"PT1H2M3S", 3723},
		{"PT45S", 45},
		{"PT2H", 7200},
		{"PT0S", 0},
		{"garbage", 0},
	}
	for _, tt := range tests {
		if got := parseISODuration(tt.iso); got != tt.want {
			t.Errorf("parseISODuration(%q) = %d, want %d", tt.iso, got, tt.want)
		}
	}
}

func TestScoreCandidate(t *testing.T) {
	const query = "come n go yeat"
	expected := 199 * time.Second

	official := Candidate{
		ID: "a", Title: "COMË N GO", ChannelTitle: "Yeat - Topic",
		DurationSeconds: 199, ViewCount: 5_000_000,
	}
	musicVideo := Candidate{
		ID: "b", Title: "Yeat - COMË N GO (Official Music Video)", ChannelTitle: "Yeat",
		DurationSeconds: 210, ViewCount: 20_000_000,
	}
	fanEdit := Candidate{
		ID: "c", Title: "yeat - come n go (slowed + reverb)", ChannelTitle: "vibes",
		DurationSeconds: 264, ViewCount: 900_000,
	}
	truncated := Candidate{
		ID: "d", Title: "come n go yeat", ChannelTitle: "clips",
		DurationSeconds: 38, ViewCount: 50_000,
	}
	wrongSong := Candidate{
		ID: "e", Title: "Totally Different Track", ChannelTitle: "Someone",
		DurationSeconds: 199, ViewCount: 100_000,
	}

	officialScore := ScoreCandidate(official, expected, query)
	if officialScore <= ScoreCandidate(musicVideo, expected, query) {
		t.Error("topic-channel exact-duration match should beat the music video")
	}
	if officialScore <= ScoreCandidate(fanEdit, expected, query) {
		t.Error("official track should beat the slowed+reverb fan edit")
	}
	if officialScore <= ScoreCandidate(truncated, expected, query) {
		t.Error("official track should beat the truncated clip")
	}
	if officialScore <= ScoreCandidate(wrongSong, expected, query) {
		t.Error("official track should beat a wrong song with matching duration")
	}

	// The truncation penalty must dominate: a 38s clip of a 199s song
	// should score negative despite matching the query.
	if ScoreCandidate(truncated, expected, query) >= 0 {
		t.Error("truncated clip should score negative")
	}

	// Clean/pitched variants must lose to the explicit original even with
	// matching duration (live-testing regression: "clean" out-scored
	// explicit at the old -10 penalty).
	clean := Candidate{
		ID: "g", Title: "COMË N GO (Clean Version)", ChannelTitle: "Project Pure Clean",
		DurationSeconds: 199, ViewCount: 500_000,
	}
	if officialScore <= ScoreCandidate(clean, expected, query) {
		t.Error("official explicit track should beat the clean version")
	}
	pitched := Candidate{
		ID: "h", Title: "come n go yeat (pitched up)", ChannelTitle: "edits",
		DurationSeconds: 199, ViewCount: 9_000,
	}
	if officialScore <= ScoreCandidate(pitched, expected, query) {
		t.Error("official track should beat the pitched-up upload")
	}

	// Accent normalization: query terms match the deaccented title.
	accented := Candidate{ID: "f", Title: "COMË N GO", ChannelTitle: "Yëat - Topic", DurationSeconds: 199, ViewCount: 5_000_000}
	if ScoreCandidate(accented, expected, "come n go yeat") < officialScore {
		t.Error("accented title/channel should still match query terms")
	}
}

func TestNormalize(t *testing.T) {
	tests := []struct{ in, want string }{
		{"COMË N GO", "come n go"},
		{"AC/DC — Thunderstruck!", "ac dc thunderstruck"},
		{"  spaced   out  ", "spaced out"},
	}
	for _, tt := range tests {
		if got := normalize(tt.in); got != tt.want {
			t.Errorf("normalize(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
