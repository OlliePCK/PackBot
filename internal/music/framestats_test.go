package music

import (
	"math"
	"testing"

	"github.com/disgoorg/disgolink/v3/lavalink"
)

func TestFrameLossPercent(t *testing.T) {
	tests := []struct {
		name string
		fs   *lavalink.FrameStats
		want float64
	}{
		{"nil (no players)", nil, 0},
		{"clean minute", &lavalink.FrameStats{Sent: 3000, Nulled: 0, Deficit: 0}, 0},
		// Slightly ahead of cadence: a negative deficit is not loss.
		{"negative deficit ignored", &lavalink.FrameStats{Sent: 3002, Deficit: -2}, 0},
		// 30 of 3000 frames missing = 1%, the warn threshold.
		{"1 percent nulled", &lavalink.FrameStats{Sent: 2970, Nulled: 30}, 1},
		{"nulled and deficit combine", &lavalink.FrameStats{Sent: 2940, Nulled: 30, Deficit: 30}, 2},
		{"heavy starvation", &lavalink.FrameStats{Sent: 1500, Nulled: 1500}, 50},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := frameLossPercent(tt.fs)
			if math.Abs(got-tt.want) > 0.001 {
				t.Errorf("frameLossPercent = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestFilterFlushPosition(t *testing.T) {
	song := &lavalink.Track{Info: lavalink.TrackInfo{IsStream: false}}
	stream := &lavalink.Track{Info: lavalink.TrackInfo{IsStream: true}}
	tests := []struct {
		name    string
		track   *lavalink.Track
		pos     lavalink.Duration
		wantPos lavalink.Duration
		wantOK  bool
	}{
		// Mid-song: flush so the new filter is audible now instead of after the
		// buffered, previously-filtered audio drains.
		{"mid song flushes at current position", song, lavalink.Duration(42000), lavalink.Duration(42000), true},
		// Nothing playing / not started: no seek to issue.
		{"no track", nil, lavalink.Duration(1000), 0, false},
		{"position zero", song, 0, 0, false},
		// Live streams are not seekable; filters still apply, just not flushed.
		{"live stream never seeks", stream, lavalink.Duration(42000), 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pos, ok := filterFlushPosition(tt.track, tt.pos)
			if ok != tt.wantOK || pos != tt.wantPos {
				t.Errorf("filterFlushPosition = (%v, %v), want (%v, %v)", pos, ok, tt.wantPos, tt.wantOK)
			}
		})
	}
}
