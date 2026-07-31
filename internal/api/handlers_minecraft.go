package api

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/OlliePCK/packbot/internal/minecraft"
)

const (
	// mcCacheTTL bounds how often the game server is actually pinged. The
	// endpoint is public and a dashboard may poll it from every open tab, so
	// the cache is what keeps that from becoming a load amplifier.
	mcCacheTTL = 15 * time.Second

	// mcAPITimeout bounds one ping so a hung dial can't hold an HTTP handler
	// open indefinitely.
	mcAPITimeout = 8 * time.Second
)

// mcStatusCache memoises the most recent ping outcome — success or failure —
// for a short window. Failures are cached too, so an unreachable server
// doesn't turn every page load into a fresh 8-second timeout.
type mcStatusCache struct {
	mu     sync.Mutex
	ttl    time.Duration
	at     time.Time
	status *minecraft.Status
	err    error
}

// get returns the cached outcome when it is still fresh, otherwise calls fetch
// and stores the result. The bool reports whether the value came from cache.
//
// now is injected so the expiry logic can be tested without sleeping.
func (c *mcStatusCache) get(now time.Time, fetch func() (*minecraft.Status, error)) (*minecraft.Status, error, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	ttl := c.ttl
	if ttl <= 0 {
		ttl = mcCacheTTL
	}
	if !c.at.IsZero() && now.Sub(c.at) < ttl {
		return c.status, c.err, true
	}

	status, err := fetch()
	c.at, c.status, c.err = now, status, err
	return status, err, false
}

// handleMinecraft is GET /api/minecraft — public, unauthenticated status for
// the PackSite widget. Mirrors what /mc reports in Discord.
func (s *Server) handleMinecraft(w http.ResponseWriter, r *http.Request) {
	if s.mc == nil {
		writeError(w, http.StatusServiceUnavailable, "minecraft integration is not configured")
		return
	}

	status, err, cached := s.mcCache.get(time.Now(), func() (*minecraft.Status, error) {
		ctx, cancel := context.WithTimeout(r.Context(), mcAPITimeout)
		defer cancel()
		return s.mc.Ping(ctx)
	})

	body := map[string]any{
		"address": s.mc.Addr,
		"cached":  cached,
	}

	if err != nil || status == nil {
		// Deliberately no error detail: this endpoint is public, and the dial
		// error can carry internal host and network information.
		body["online"] = false
		writeJSON(w, http.StatusOK, body)
		return
	}

	sample := make([]string, 0, len(status.Players.Sample))
	for _, p := range status.Players.Sample {
		if p.Name != "" {
			sample = append(sample, p.Name)
		}
	}

	body["online"] = true
	body["version"] = status.Version.Name
	body["motd"] = status.DescriptionText()
	body["latencyMs"] = status.Latency.Milliseconds()
	body["players"] = map[string]any{
		"online": status.Players.Online,
		"max":    status.Players.Max,
		"sample": sample,
	}

	writeJSON(w, http.StatusOK, body)
}
