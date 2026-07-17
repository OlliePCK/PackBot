package music

import (
	"fmt"
	"math/rand/v2"
)

// Accessor/mutator methods for GuildPlayer used by command handlers. Each
// takes the lock; command handlers never touch fields directly.

// Snapshot is a consistent copy of queue state for rendering.
type Snapshot struct {
	Current    *Track
	Queue      []*Track
	RepeatMode RepeatMode
	Autoplay   bool
	Volume     int
	HistoryLen int
}

// Snapshot returns a copy of the current state (queue slice is copied;
// tracks are shared pointers — render-only use).
func (gp *GuildPlayer) Snapshot() Snapshot {
	gp.mu.Lock()
	defer gp.mu.Unlock()
	queue := make([]*Track, len(gp.Queue))
	copy(queue, gp.Queue)
	return Snapshot{
		Current:    gp.Current,
		Queue:      queue,
		RepeatMode: gp.RepeatMode,
		Autoplay:   gp.Autoplay,
		Volume:     gp.Volume,
		HistoryLen: len(gp.History),
	}
}

// changed fires the manager's update notification (call without gp.mu held).
func (gp *GuildPlayer) changed() {
	if gp.onChange != nil {
		gp.onChange()
	}
}

// CurrentTrack returns the playing track (nil when idle).
func (gp *GuildPlayer) CurrentTrack() *Track {
	gp.mu.Lock()
	defer gp.mu.Unlock()
	return gp.Current
}

// QueueLength returns the number of queued tracks.
func (gp *GuildPlayer) QueueLength() int {
	gp.mu.Lock()
	defer gp.mu.Unlock()
	return len(gp.Queue)
}

// SetRepeatMode sets the repeat mode.
func (gp *GuildPlayer) SetRepeatMode(mode RepeatMode) {
	gp.mu.Lock()
	gp.RepeatMode = mode
	gp.mu.Unlock()
	gp.changed()
}

// ToggleAutoplay flips autoplay and returns the new state.
func (gp *GuildPlayer) ToggleAutoplay() bool {
	gp.mu.Lock()
	gp.Autoplay = !gp.Autoplay
	enabled := gp.Autoplay
	gp.mu.Unlock()
	gp.changed()
	return enabled
}

// ShuffleQueue Fisher-Yates shuffles the queue, returning its length.
func (gp *GuildPlayer) ShuffleQueue() int {
	gp.mu.Lock()
	rand.Shuffle(len(gp.Queue), func(a, b int) {
		gp.Queue[a], gp.Queue[b] = gp.Queue[b], gp.Queue[a]
	})
	n := len(gp.Queue)
	gp.mu.Unlock()
	gp.changed()
	return n
}

// RemoveAt removes and returns the 0-based queue entry (web API).
func (gp *GuildPlayer) RemoveAt(index int) (*Track, error) {
	gp.mu.Lock()
	if index < 0 || index >= len(gp.Queue) {
		gp.mu.Unlock()
		return nil, fmt.Errorf("invalid position")
	}
	track := gp.Queue[index]
	gp.Queue = append(gp.Queue[:index], gp.Queue[index+1:]...)
	gp.mu.Unlock()
	gp.changed()
	return track, nil
}

// MoveTrack moves a queue entry between 0-based positions (web API).
func (gp *GuildPlayer) MoveTrack(from, to int) (*Track, error) {
	gp.mu.Lock()
	n := len(gp.Queue)
	if from < 0 || from >= n || to < 0 || to >= n {
		gp.mu.Unlock()
		return nil, fmt.Errorf("invalid positions")
	}
	track := gp.Queue[from]
	gp.Queue = append(gp.Queue[:from], gp.Queue[from+1:]...)
	rest := append([]*Track(nil), gp.Queue[to:]...)
	gp.Queue = append(gp.Queue[:to], append([]*Track{track}, rest...)...)
	gp.mu.Unlock()
	gp.changed()
	return track, nil
}

// ClearQueue empties the queue, returning how many entries were removed.
func (gp *GuildPlayer) ClearQueue() int {
	gp.mu.Lock()
	n := len(gp.Queue)
	gp.Queue = nil
	gp.mu.Unlock()
	gp.changed()
	return n
}

// SwapQueue swaps two 0-based queue positions.
func (gp *GuildPlayer) SwapQueue(a, b int) error {
	gp.mu.Lock()
	defer gp.mu.Unlock()
	n := len(gp.Queue)
	if n < 2 {
		return fmt.Errorf("Need at least 2 songs in the queue to swap.")
	}
	if a < 0 || a >= n || b < 0 || b >= n {
		return fmt.Errorf("Please enter valid positions between 1 and %d.", n)
	}
	if a == b {
		return fmt.Errorf("Both positions are the same.")
	}
	gp.Queue[a], gp.Queue[b] = gp.Queue[b], gp.Queue[a]
	defer gp.changed()
	return nil
}

// PushToFront moves a 0-based queue position to the front.
func (gp *GuildPlayer) PushToFront(index int) (*Track, error) {
	gp.mu.Lock()
	defer gp.mu.Unlock()
	n := len(gp.Queue)
	if n == 0 {
		return nil, fmt.Errorf("Queue is empty.")
	}
	if index < 0 || index >= n {
		return nil, fmt.Errorf("Please enter a valid position between 1 and %d.", n)
	}
	if index == 0 {
		return nil, fmt.Errorf("That song is already next.")
	}
	track := gp.Queue[index]
	gp.Queue = append(gp.Queue[:index], gp.Queue[index+1:]...)
	gp.Queue = append([]*Track{track}, gp.Queue...)
	defer gp.changed()
	return track, nil
}

// PopLast removes and returns the last queued track (nil when empty).
func (gp *GuildPlayer) PopLast() *Track {
	gp.mu.Lock()
	defer gp.mu.Unlock()
	if len(gp.Queue) == 0 {
		return nil
	}
	last := gp.Queue[len(gp.Queue)-1]
	gp.Queue = gp.Queue[:len(gp.Queue)-1]
	defer gp.changed()
	return last
}
