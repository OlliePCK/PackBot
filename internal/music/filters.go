package music

import (
	"context"
	"fmt"
	"sort"

	"github.com/disgoorg/disgolink/v3/lavalink"
	"github.com/disgoorg/snowflake/v2"
)

// Audio filters on Lavalink's live filter engine. Unlike the Node bot's
// FFmpeg approach (kill pipeline → respawn → seek back), Lavalink applies
// filter changes to the running stream — no restart, no position juggling.
//
// The FFmpeg-only exotics (reverse, surround, haas, mcompand, flanger, gate,
// phaser, normalizer) were dropped per the FEATURES.md port decisions.

// FilterDef applies one named filter onto a lavalink.Filters struct.
type FilterDef struct {
	Key   string
	Name  string
	apply func(*lavalink.Filters)
}

func ptr[T any](v T) *T { return &v }

// filterDefs is the supported filter set, keyed as in the Node bot.
var filterDefs = map[string]FilterDef{
	"bassboost": {Key: "bassboost", Name: "Bass Boost", apply: func(f *lavalink.Filters) {
		// Tuned by ear in live testing ("almost perfect" at 0.55, dialed
		// back a notch). Range is -0.25..1.
		f.Equalizer = &lavalink.Equalizer{0: 0.48, 1: 0.44, 2: 0.38, 3: 0.26, 4: 0.12}
	}},
	"treble": {Key: "treble", Name: "Treble", apply: func(f *lavalink.Filters) {
		f.Equalizer = &lavalink.Equalizer{10: 0.4, 11: 0.45, 12: 0.5, 13: 0.5, 14: 0.45}
	}},
	"nightcore": {Key: "nightcore", Name: "Nightcore", apply: func(f *lavalink.Filters) {
		f.Timescale = &lavalink.Timescale{Speed: 1.3, Pitch: 1.25, Rate: 1}
	}},
	"vaporwave": {Key: "vaporwave", Name: "Vaporwave", apply: func(f *lavalink.Filters) {
		f.Timescale = &lavalink.Timescale{Speed: 0.75, Pitch: 0.8, Rate: 1}
	}},
	"8d": {Key: "8d", Name: "8D Audio", apply: func(f *lavalink.Filters) {
		// 0.2 Hz = the classic slow 8D sweep. Requires the local disgolink
		// patch in third_party/ (upstream types RotationHz as int, which
		// also breaks parsing Lavalink's float echo of this field).
		f.Rotation = &lavalink.Rotation{RotationHz: 0.2}
	}},
	"tremolo": {Key: "tremolo", Name: "Tremolo", apply: func(f *lavalink.Filters) {
		f.Tremolo = &lavalink.Tremolo{Frequency: 2.0, Depth: 0.5}
	}},
	"vibrato": {Key: "vibrato", Name: "Vibrato", apply: func(f *lavalink.Filters) {
		f.Vibrato = &lavalink.Vibrato{Frequency: 6.5, Depth: 0.5}
	}},
	"karaoke": {Key: "karaoke", Name: "Karaoke", apply: func(f *lavalink.Filters) {
		f.Karaoke = &lavalink.Karaoke{Level: 1, MonoLevel: 1, FilterBand: 220, FilterWidth: 100}
	}},
	"pitch_up": {Key: "pitch_up", Name: "Pitch Up", apply: func(f *lavalink.Filters) {
		setTimescalePitch(f, 1.15)
	}},
	"pitch_down": {Key: "pitch_down", Name: "Pitch Down", apply: func(f *lavalink.Filters) {
		setTimescalePitch(f, 0.85)
	}},
	"slow": {Key: "slow", Name: "Slow", apply: func(f *lavalink.Filters) {
		setTimescaleSpeed(f, 0.8)
	}},
	"fast": {Key: "fast", Name: "Fast", apply: func(f *lavalink.Filters) {
		setTimescaleSpeed(f, 1.25)
	}},
	"earrape": {Key: "earrape", Name: "Earrape", apply: func(f *lavalink.Filters) {
		// Max filter volume (Lavalink caps at 5×) + every EQ band maxed:
		// guaranteed clipping chaos. (The previous Distortion{Scale:0.5}
		// actually *halved* the samples — lavaplayer's scale is a multiplier.)
		f.Volume = ptr(lavalink.Volume(5.0))
		f.Equalizer = &lavalink.Equalizer{
			0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1,
			8: 1, 9: 1, 10: 1, 11: 1, 12: 1, 13: 1, 14: 1,
		}
	}},
	"slowed_reverb": {Key: "slowed_reverb", Name: "Slowed + Reverb", apply: func(f *lavalink.Filters) {
		// The YouTube "slowed + reverb" trend sound: slowed with a slight
		// pitch drop, plus true comb-filter reverb (lavalink-filter-plugin).
		// Added on Ollie's request (goes beyond Node parity). Delay/gain
		// arrays are the plugin's reference room preset.
		f.Timescale = &lavalink.Timescale{Speed: 0.82, Pitch: 0.9, Rate: 1}
		if f.PluginFilters == nil {
			f.PluginFilters = map[string]any{}
		}
		f.PluginFilters["reverb"] = map[string]any{
			"delays": []float64{0.037, 0.042, 0.048, 0.053},
			"gains":  []float64{0.84, 0.83, 0.82, 0.81},
		}
	}},
}

// setTimescalePitch/Speed merge with an existing timescale so pitch and
// speed filters compose (e.g. slow + pitch_down).
func setTimescalePitch(f *lavalink.Filters, pitch float64) {
	if f.Timescale == nil {
		f.Timescale = &lavalink.Timescale{Speed: 1, Pitch: 1, Rate: 1}
	}
	f.Timescale.Pitch = pitch
}

func setTimescaleSpeed(f *lavalink.Filters, speed float64) {
	if f.Timescale == nil {
		f.Timescale = &lavalink.Timescale{Speed: 1, Pitch: 1, Rate: 1}
	}
	f.Timescale.Speed = speed
}

// FilterChoices lists the available filters sorted by display name (for the
// slash-command choices).
func FilterChoices() []FilterDef {
	defs := make([]FilterDef, 0, len(filterDefs))
	for _, def := range filterDefs {
		defs = append(defs, def)
	}
	sort.Slice(defs, func(a, b int) bool { return defs[a].Name < defs[b].Name })
	return defs
}

// FilterName returns the display name for a filter key.
func FilterName(key string) string {
	if def, ok := filterDefs[key]; ok {
		return def.Name
	}
	return key
}

// buildFilters composes the lavalink filter payload from active keys, in
// activation order (later filters win on conflicting fields).
func buildFilters(active []string) lavalink.Filters {
	var f lavalink.Filters
	for _, key := range active {
		if def, ok := filterDefs[key]; ok {
			def.apply(&f)
		}
	}
	return f
}

// AddFilter activates a filter. Returns the active list or an error if it
// was already active / unknown.
func (m *Manager) AddFilter(ctx context.Context, guildID, key string) ([]string, error) {
	if _, ok := filterDefs[key]; !ok {
		return nil, fmt.Errorf("unknown filter %q", key)
	}
	gp := m.Guild(guildID)
	gp.mu.Lock()
	for _, existing := range gp.Filters {
		if existing == key {
			gp.mu.Unlock()
			return nil, fmt.Errorf("the **%s** filter is already active!", FilterName(key))
		}
	}
	gp.Filters = append(gp.Filters, key)
	active := append([]string(nil), gp.Filters...)
	gp.mu.Unlock()

	return active, m.applyFilters(ctx, guildID, active)
}

// RemoveFilter deactivates a filter.
func (m *Manager) RemoveFilter(ctx context.Context, guildID, key string) ([]string, error) {
	gp := m.Guild(guildID)
	gp.mu.Lock()
	found := false
	next := gp.Filters[:0]
	for _, existing := range gp.Filters {
		if existing == key {
			found = true
			continue
		}
		next = append(next, existing)
	}
	gp.Filters = next
	active := append([]string(nil), gp.Filters...)
	gp.mu.Unlock()

	if !found {
		return nil, fmt.Errorf("**%s** is not active.", FilterName(key))
	}
	return active, m.applyFilters(ctx, guildID, active)
}

// ClearFilters removes all filters. Returns how many were cleared.
func (m *Manager) ClearFilters(ctx context.Context, guildID string) (int, error) {
	gp := m.Guild(guildID)
	gp.mu.Lock()
	n := len(gp.Filters)
	gp.Filters = nil
	gp.mu.Unlock()
	if n == 0 {
		return 0, nil
	}
	return n, m.applyFilters(ctx, guildID, nil)
}

// ActiveFilters returns the active filter keys.
func (m *Manager) ActiveFilters(guildID string) []string {
	gp := m.Guild(guildID)
	gp.mu.Lock()
	defer gp.mu.Unlock()
	return append([]string(nil), gp.Filters...)
}

func (m *Manager) applyFilters(ctx context.Context, guildID string, active []string) error {
	m.notifyUpdate(guildID)
	player := m.client.ExistingPlayer(snowflake.MustParse(guildID))
	if player == nil {
		return nil // stored; applied when playback starts
	}
	return player.Update(ctx, lavalink.WithFilters(buildFilters(active)))
}
