package api

import (
	"errors"
	"testing"
	"time"

	"github.com/OlliePCK/packbot/internal/minecraft"
)

func TestMCCacheServesWithinTTL(t *testing.T) {
	c := &mcStatusCache{ttl: 15 * time.Second}
	base := time.Now()
	calls := 0
	fetch := func() (*minecraft.Status, error) {
		calls++
		return &minecraft.Status{}, nil
	}

	if _, _, cached := c.get(base, fetch); cached {
		t.Error("first call should be a miss")
	}
	if _, _, cached := c.get(base.Add(14*time.Second), fetch); !cached {
		t.Error("call inside the TTL should be served from cache")
	}
	if calls != 1 {
		t.Errorf("fetch called %d times, want 1", calls)
	}
}

func TestMCCacheRefreshesAfterTTL(t *testing.T) {
	c := &mcStatusCache{ttl: 15 * time.Second}
	base := time.Now()
	calls := 0
	fetch := func() (*minecraft.Status, error) {
		calls++
		return &minecraft.Status{}, nil
	}

	c.get(base, fetch)
	if _, _, cached := c.get(base.Add(15*time.Second), fetch); cached {
		t.Error("call at exactly the TTL should refresh")
	}
	if calls != 2 {
		t.Errorf("fetch called %d times, want 2", calls)
	}
}

func TestMCCacheCachesFailures(t *testing.T) {
	// An unreachable server must not turn every request into a fresh timeout.
	c := &mcStatusCache{ttl: 15 * time.Second}
	base := time.Now()
	calls := 0
	wantErr := errors.New("dial refused")
	fetch := func() (*minecraft.Status, error) {
		calls++
		return nil, wantErr
	}

	if _, err, _ := c.get(base, fetch); !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, want %v", err, wantErr)
	}
	_, err, cached := c.get(base.Add(5*time.Second), fetch)
	if !cached {
		t.Error("failures should be cached too")
	}
	if !errors.Is(err, wantErr) {
		t.Errorf("cached err = %v, want %v", err, wantErr)
	}
	if calls != 1 {
		t.Errorf("fetch called %d times, want 1", calls)
	}
}

func TestMCCacheDefaultsTTLWhenUnset(t *testing.T) {
	c := &mcStatusCache{} // zero value, as an un-initialised Server field would be
	base := time.Now()
	calls := 0
	fetch := func() (*minecraft.Status, error) {
		calls++
		return &minecraft.Status{}, nil
	}

	c.get(base, fetch)
	if _, _, cached := c.get(base.Add(time.Second), fetch); !cached {
		t.Error("zero-value cache should fall back to mcCacheTTL, not zero")
	}
	if calls != 1 {
		t.Errorf("fetch called %d times, want 1", calls)
	}
}
