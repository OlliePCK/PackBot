package music

import "testing"

func TestNormalizeSongKey(t *testing.T) {
	tests := []struct{ in, want string }{
		{"COMË N GO", "comngo"},
		{"Janice STFU (Official Audio)", "janicestfu"},
		{"Yeat - Topic", "yeat"},
		{"SHABANG [Lyrics]", "shabang"},
		{"Drake", "drake"},
	}
	for _, tt := range tests {
		if got := normalizeSongKey(tt.in); got != tt.want {
			t.Errorf("normalizeSongKey(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestQueryMatchesTrack(t *testing.T) {
	tests := []struct {
		query, name, artist string
		want                bool
	}{
		// Real Spotify metadata (verified via the search API).
		{"janice stfu", "Janice STFU", "Drake", true},
		{"come n go yeat", "COMË N GO", "Yeat", true},
		// Parenthetical content in a title must still count as query terms.
		{"sicko mode", "SICKO MODE (feat. Drake)", "Travis Scott", true},
		{"obscure youtube meme song", "Completely Different Track", "Random Artist", false},
		{"drake", "Drake's Best Song", "Drake", true},
		{"", "Anything", "Anyone", false},
	}
	for _, tt := range tests {
		if got := queryMatchesTrack(tt.query, tt.name, tt.artist); got != tt.want {
			t.Errorf("queryMatchesTrack(%q, %q, %q) = %v, want %v", tt.query, tt.name, tt.artist, got, tt.want)
		}
	}
}

func TestBuildFilters(t *testing.T) {
	// Composition: slow + pitch_down share the timescale struct.
	f := buildFilters([]string{"slow", "pitch_down"})
	if f.Timescale == nil {
		t.Fatal("timescale not set")
	}
	if f.Timescale.Speed != 0.8 || f.Timescale.Pitch != 0.85 {
		t.Errorf("timescale = %+v, want speed 0.8 pitch 0.85", f.Timescale)
	}

	// Preset overrides earlier timescale tweaks (later filter wins).
	f = buildFilters([]string{"slow", "nightcore"})
	if f.Timescale == nil || f.Timescale.Speed != 1.3 {
		t.Errorf("nightcore should override slow, got %+v", f.Timescale)
	}

	// Independent filters coexist.
	f = buildFilters([]string{"bassboost", "8d", "tremolo"})
	if f.Equalizer == nil || f.Rotation == nil || f.Tremolo == nil {
		t.Error("bassboost + 8d + tremolo should all be present")
	}

	// Empty list = zero-value payload (clears all filters on Lavalink).
	f = buildFilters(nil)
	if f.Timescale != nil || f.Equalizer != nil || f.Rotation != nil {
		t.Error("empty filter list should produce empty payload")
	}

	// Slowed + Reverb sets timescale and the reverb plugin filter.
	f = buildFilters([]string{"slowed_reverb"})
	if f.Timescale == nil || f.Timescale.Speed != 0.82 {
		t.Errorf("slowed_reverb timescale = %+v", f.Timescale)
	}
	if _, ok := f.PluginFilters["reverb"]; !ok {
		t.Error("slowed_reverb should set the reverb plugin filter")
	}
}
