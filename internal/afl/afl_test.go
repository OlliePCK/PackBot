package afl

import (
	"testing"
	"time"
)

func TestParseRow(t *testing.T) {
	row := map[string]any{
		"game_id": float64(38653), "date": "2026-07-17 19:40:00", "roundname": "Round 19",
		"venue": "S.C.G.", "home_team": "Sydney", "away_team": "Adelaide",
		"home_win_prob": 0.5932, "away_win_prob": 0.4068,
		"predicted_winner": "Sydney", "predicted_margin": 4.4375,
	}
	m, err := parseRow(row)
	if err != nil {
		t.Fatalf("parseRow: %v", err)
	}
	if m.Home != "Sydney" || m.Away != "Adelaide" || m.Round != "Round 19" {
		t.Errorf("fields wrong: %+v", m)
	}
	if got := m.Kickoff.In(sydney).Format("15:04"); got != "19:40" {
		t.Errorf("kickoff = %s, want 19:40 Sydney", got)
	}
	if m.GameID != "38653" {
		t.Errorf("GameID = %q, want 38653", m.GameID)
	}

	// commence_time (UTC) wins over the Sydney wall-time date when present.
	row["commence_time"] = "2026-07-17T09:41:02.000Z"
	m2, _ := parseRow(row)
	if got := m2.Kickoff.In(sydney).Format("15:04:05"); got != "19:41:02" {
		t.Errorf("commence_time kickoff = %s, want 19:41:02 Sydney", got)
	}
	delete(row, "commence_time")
	if m.HomeOdds != 0 {
		t.Errorf("empty odds should parse to 0, got %v", m.HomeOdds)
	}
	if got := m.WinnerProb(); got != 0.5932 {
		t.Errorf("WinnerProb = %v", got)
	}

	// Away-tipped match reports the away probability.
	row["predicted_winner"] = "Adelaide"
	m, _ = parseRow(row)
	if got := m.WinnerProb(); got != 0.4068 {
		t.Errorf("away WinnerProb = %v, want 0.4068", got)
	}

	if _, err := parseRow(map[string]any{"date": "garbage"}); err == nil {
		t.Error("expected error for bad date")
	}
}

func TestCurrentRound(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, sydney)
	matches := []Match{
		{Round: "Round 18", Kickoff: now.Add(-72 * time.Hour)},
		{Round: "Round 19", Kickoff: now.Add(8 * time.Hour)},
		{Round: "Round 19", Kickoff: now.Add(30 * time.Hour)},
	}
	round, rm := CurrentRound(matches, now)
	if round != "Round 19" || len(rm) != 2 {
		t.Errorf("got %q with %d matches, want Round 19 with 2", round, len(rm))
	}

	// All matches played: falls back to the last round in the data.
	past := []Match{{Round: "Round 19", Kickoff: now.Add(-30 * time.Hour)}}
	round, rm = CurrentRound(past, now)
	if round != "Round 19" || len(rm) != 1 {
		t.Errorf("fallback got %q/%d", round, len(rm))
	}

	if round, _ := CurrentRound(nil, now); round != "" {
		t.Errorf("empty input should yield empty round, got %q", round)
	}
}

func TestLastThursdayAnnounce(t *testing.T) {
	tests := []struct {
		name string
		now  time.Time
		want time.Time
	}{
		{
			"friday is inside the window",
			time.Date(2026, 7, 17, 12, 0, 0, 0, sydney), // Fri
			time.Date(2026, 7, 16, 19, 0, 0, 0, sydney), // Thu 19:00
		},
		{
			"thursday before 19:00 belongs to last week",
			time.Date(2026, 7, 16, 18, 0, 0, 0, sydney),
			time.Date(2026, 7, 9, 19, 0, 0, 0, sydney),
		},
		{
			"thursday 19:00 exactly is this week",
			time.Date(2026, 7, 16, 19, 0, 0, 0, sydney),
			time.Date(2026, 7, 16, 19, 0, 0, 0, sydney),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := lastThursdayAnnounce(tt.now); !got.Equal(tt.want) {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}

	// The posting window (< 4 days after Thursday 19:00) must exclude the
	// Tuesday 06:00 full-cycle refresh, which flips the dataset to the next
	// round before teams are announced.
	tue := time.Date(2026, 7, 21, 6, 30, 0, 0, sydney)
	if gap := tue.Sub(lastThursdayAnnounce(tue)); gap <= 4*24*time.Hour {
		t.Errorf("tuesday morning gap %v should exceed the 4-day window", gap)
	}
	fri := time.Date(2026, 7, 17, 12, 0, 0, 0, sydney)
	if gap := fri.Sub(lastThursdayAnnounce(fri)); gap > 4*24*time.Hour {
		t.Errorf("friday gap %v should be inside the window", gap)
	}
}

func TestTeamsRegistryComplete(t *testing.T) {
	if len(Teams) != 18 {
		t.Fatalf("expected 18 teams, got %d", len(Teams))
	}
	for name, team := range Teams {
		if _, err := logoFS.ReadFile("logos/" + team.Emoji + ".png"); err != nil {
			t.Errorf("%s: embedded logo missing: %v", name, err)
		}
		if team.Accent == 0 && name != "Collingwood" { // black is legitimately 0x000000
			t.Errorf("%s: accent colour unset", name)
		}
	}
}

func TestProbBar(t *testing.T) {
	tests := []struct {
		p    float64
		want string
	}{
		{0.0, "▱▱▱▱▱▱▱▱▱▱"},
		{0.59, "▰▰▰▰▰▰▱▱▱▱"},
		{1.0, "▰▰▰▰▰▰▰▰▰▰"},
	}
	for _, tt := range tests {
		if got := probBar(tt.p); got != tt.want {
			t.Errorf("probBar(%v) = %s, want %s", tt.p, got, tt.want)
		}
	}
}
