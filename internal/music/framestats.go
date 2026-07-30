package music

import (
	"context"
	"time"

	"github.com/disgoorg/disgolink/v3/lavalink"
)

// Frame-delivery monitoring. Lavalink pushes node stats over the WebSocket
// every minute, including frame counters for that window; the REST /v4/stats
// route always reports frameStats as null, so these numbers are only visible
// from the client side. Without this the bot received them and threw them away,
// which left "the audio sounded warbly" undiagnosable after the fact.

// frameStatsInterval matches Lavalink's own stats cadence.
const frameStatsInterval = time.Minute

// expectedFramesPerMinute is Discord's Opus cadence: one 20ms frame every
// 20ms = 50/s. A healthy minute of playback sends ~3000 frames per player.
const expectedFramesPerMinute = 50 * 60

// frameLossPercent reports missed frames as a percentage of the expected
// cadence. Nulled frames are ones Lavalink had no audio for (a starved buffer);
// deficit is how far short of the expected count it fell. Negative deficits
// (slightly ahead of cadence) are treated as no loss.
func frameLossPercent(fs *lavalink.FrameStats) float64 {
	if fs == nil {
		return 0
	}
	lost := fs.Nulled
	if fs.Deficit > 0 {
		lost += fs.Deficit
	}
	if lost <= 0 {
		return 0
	}
	return float64(lost) / float64(expectedFramesPerMinute) * 100
}

// monitorFrameStats logs frame-delivery health while tracks are playing. It is
// quiet when delivery is clean, so anything it prints is worth reading: sizable
// loss means the frame buffer is being starved by the source, which is what
// produces interpolated/warbling audio at the listener.
func (m *Manager) monitorFrameStats(ctx context.Context) {
	ticker := time.NewTicker(frameStatsInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		node := m.client.Node(nodeName)
		if node == nil {
			continue
		}
		stats := node.Stats()
		fs := stats.FrameStats
		if fs == nil {
			continue // no players on the node this window
		}
		loss := frameLossPercent(fs)
		if loss == 0 {
			continue
		}

		log := m.log.Info
		if loss >= 1 {
			// ~1% is roughly 30 missing frames a minute: audible warble.
			log = m.log.Warn
		}
		log("lavalink frame delivery degraded",
			"loss_percent", float64(int(loss*100+0.5))/100,
			"sent", fs.Sent,
			"nulled", fs.Nulled,
			"deficit", fs.Deficit,
			"players", stats.PlayingPlayers,
		)
	}
}
