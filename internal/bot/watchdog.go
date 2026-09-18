// Gateway watchdog.
//
// On 2026-09-14 PackBot went silently offline for four days. The gateway
// WebSocket dropped, discordgo's own reconnect machinery wedged, and nothing
// in the process noticed: cron jobs kept firing, /api/stats kept answering
// 200, the container kept reporting a healthy four-day uptime. Discord saw the
// bot as offline the entire time and not one interaction arrived — the only
// visible symptom was a friend saying "the music bot is broken".
//
// The wedge is a race in discordgo v0.29. Both listen() (on a read error,
// wsapi.go:229) and heartbeat() (on a missed ACK, wsapi.go:302) respond by
// calling Close() then reconnect(). When the two interleave, one goroutine's
// Open() installs a fresh s.wsConn while the other's Close() tears that new
// socket down, leaving s.wsConn non-nil with nothing behind it. Every later
// reconnect() then hits `if err == ErrWSAlreadyOpen { return }`
// (wsapi.go:918) and gives up without retrying. The read error that starts it
// all is logged at LogWarning, which discordgo's default LogLevel discards,
// which is why four days of downtime left no trace in the logs.
//
// Nothing inside discordgo recovers from that state, so this watchdog does.

package bot

import (
	"context"
	"log/slog"
	"time"

	"github.com/bwmarrin/discordgo"
)

const (
	// GatewayStaleAfter is how long without a heartbeat ACK means the gateway
	// is gone. Discord's heartbeat interval is ~41s, so this is roughly seven
	// missed beats: far too long to trip on a transient hiccup or a reconnect
	// already in flight, short enough that an outage lasts minutes not days.
	GatewayStaleAfter = 5 * time.Minute

	// gatewayCheckEvery is the poll interval. Cheap — it reads one timestamp.
	gatewayCheckEvery = 30 * time.Second

	// maxRecoveryBackoff caps the wait between failed recovery attempts.
	// Each attempt costs an IDENTIFY, and Discord allows 1000 per day.
	maxRecoveryBackoff = 15 * time.Minute
)

// HeartbeatAge reports how long ago the gateway last acknowledged a
// heartbeat. ok is false before the first ACK, i.e. while the session has
// never successfully connected — the initial connect is Run()'s job, not the
// watchdog's.
//
// A frozen ACK is the reliable signal for the wedge above: discordgo's
// heartbeat goroutine has returned, so the timestamp simply stops advancing
// while the process carries on looking healthy.
func HeartbeatAge(s *discordgo.Session) (time.Duration, bool) {
	s.RLock()
	ack := s.LastHeartbeatAck
	s.RUnlock()
	if ack.IsZero() {
		return 0, false
	}
	return time.Since(ack), true
}

// GatewayHealthy reports whether the gateway has ACKed recently enough to be
// considered live. It is true before the first connection so startup isn't
// reported as an outage.
func GatewayHealthy(s *discordgo.Session) bool {
	age, ok := HeartbeatAge(s)
	return !ok || age <= GatewayStaleAfter
}

// watchGateway polls the heartbeat ACK and forces a reconnect when it goes
// stale. It returns when ctx is cancelled.
func (b *Bot) watchGateway(ctx context.Context) {
	ticker := time.NewTicker(gatewayCheckEvery)
	defer ticker.Stop()

	var (
		failures    int
		nextAttempt time.Time
	)

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			age, ok := HeartbeatAge(b.session)
			if !ok || age <= GatewayStaleAfter {
				failures = 0
				continue
			}
			if now.Before(nextAttempt) {
				continue
			}

			slog.Error("gateway has gone silent; forcing reconnect",
				"last_ack_age", age.Round(time.Second), "attempt", failures+1)

			if err := b.reopenGateway(ctx); err != nil {
				failures++
				wait := recoveryBackoff(failures)
				nextAttempt = now.Add(wait)
				slog.Error("gateway reconnect failed", "error", err, "retry_in", wait)
				continue
			}

			failures = 0
			// Open() refreshes LastHeartbeatAck, so staleness normally clears
			// on its own. Hold off anyway in case it reconnects into a state
			// that never ACKs, so we re-identify at most once a minute.
			nextAttempt = now.Add(time.Minute)
			slog.Info("gateway reconnected by watchdog")
		}
	}
}

// reopenGateway tears the session down and dials again. The Close() is the
// point of the whole exercise: it clears s.wsConn, without which Open()
// returns ErrWSAlreadyOpen and changes nothing.
func (b *Bot) reopenGateway(ctx context.Context) error {
	// Close() on a dead socket usually fails writing its close frame. It nils
	// out s.wsConn regardless, which is all we need, so the error is worth
	// recording but not worth stopping for.
	if err := b.session.Close(); err != nil {
		slog.Warn("gateway watchdog: close returned an error (continuing)", "error", err)
	}
	if err := ctx.Err(); err != nil {
		return err // shutting down; Run() owns the session from here
	}
	return b.session.Open()
}

// recoveryBackoff spaces out repeated failed reconnects: 1m, 2m, 4m… capped.
func recoveryBackoff(failures int) time.Duration {
	if failures < 1 {
		failures = 1
	}
	if failures > 8 { // guard the shift; 1m<<8 is already past the cap
		failures = 8
	}
	wait := time.Minute << (failures - 1)
	if wait > maxRecoveryBackoff {
		wait = maxRecoveryBackoff
	}
	return wait
}
