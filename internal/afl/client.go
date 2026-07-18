package afl

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"
)

// Match is one row of the model's upcoming_predictions output, parsed. The
// API serves the CSV as JSON with every value stringly-typed.
type Match struct {
	GameID    string
	Kickoff   time.Time // absolute instant (source is Sydney wall time)
	Round     string    // e.g. "Round 19"
	Venue     string
	Home      string
	Away      string
	HomeProb  float64
	AwayProb  float64
	Winner    string
	Margin    float64 // home-relative: negative means the away side wins
	HomeOdds  float64 // 0 when the market snapshot is missing
	AwayOdds  float64
}

// WinnerProb is the model's probability for its tipped winner.
func (m Match) WinnerProb() float64 {
	if m.Winner == m.Away {
		return m.AwayProb
	}
	return m.HomeProb
}

// sydney is the fixture timezone: the model's `date` column is Squiggle's
// AEST/AEDT wall time (verified against Perth fixtures, which differ from
// their venue-local `localtime` by the WA offset).
var sydney = mustLoadSydney()

func mustLoadSydney() *time.Location {
	loc, err := time.LoadLocation("Australia/Sydney")
	if err != nil {
		panic(fmt.Sprintf("afl: load Australia/Sydney tz: %v", err))
	}
	return loc
}

// Client reads the model dashboard's API.
type Client struct {
	baseURL string
	http    *http.Client
}

// NewClient targets the dashboard at baseURL (e.g. "http://192.168.1.16:3002").
func NewClient(baseURL string) *Client {
	return &Client{baseURL: baseURL, http: &http.Client{Timeout: 15 * time.Second}}
}

// Predictions fetches the current prediction set, sorted by kickoff.
func (c *Client) Predictions(ctx context.Context) ([]Match, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/predictions", nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("afl: fetch predictions: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("afl: fetch predictions: status %d", resp.StatusCode)
	}

	// The route serves the CSV joined with the odds snapshot: strings for
	// text columns but real JSON numbers for probabilities/odds/IDs, and
	// columns appear or vanish depending on whether odds have been fetched.
	var rows []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&rows); err != nil {
		return nil, fmt.Errorf("afl: decode predictions: %w", err)
	}

	matches := make([]Match, 0, len(rows))
	for _, r := range rows {
		m, err := parseRow(r)
		if err != nil {
			return nil, fmt.Errorf("afl: parse prediction row (game %v): %w", r["game_id"], err)
		}
		matches = append(matches, m)
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].Kickoff.Before(matches[j].Kickoff) })
	return matches, nil
}

func parseRow(r map[string]any) (Match, error) {
	str := func(key string) string {
		switch v := r[key].(type) {
		case string:
			return v
		case float64:
			return strconv.FormatFloat(v, 'f', -1, 64)
		default:
			return ""
		}
	}
	num := func(key string) float64 {
		switch v := r[key].(type) {
		case float64:
			return v
		case string:
			f, _ := strconv.ParseFloat(v, 64)
			return f
		default:
			return 0
		}
	}

	// Kickoff: prefer commence_time (exact UTC instant from the odds feed);
	// fall back to the fixture's Sydney wall-time `date` when odds haven't
	// been fetched yet.
	var kickoff time.Time
	if ct := str("commence_time"); ct != "" {
		if t, err := time.Parse(time.RFC3339, ct); err == nil {
			kickoff = t
		}
	}
	if kickoff.IsZero() {
		t, err := time.ParseInLocation("2006-01-02 15:04:05", str("date"), sydney)
		if err != nil {
			return Match{}, fmt.Errorf("bad date %q: %w", str("date"), err)
		}
		kickoff = t
	}

	m := Match{
		GameID:   str("game_id"),
		Kickoff:  kickoff,
		Round:    str("roundname"),
		Venue:    str("venue"),
		Home:     str("home_team"),
		Away:     str("away_team"),
		HomeProb: num("home_win_prob"),
		AwayProb: num("away_win_prob"),
		Winner:   str("predicted_winner"),
		Margin:   num("predicted_margin"),
		HomeOdds: num("home_odds"),
		AwayOdds: num("away_odds"),
	}
	if m.Home == "" || m.Away == "" || m.Round == "" {
		return Match{}, fmt.Errorf("missing team/round fields")
	}
	return m, nil
}
