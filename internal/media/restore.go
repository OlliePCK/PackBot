package media

import (
	"fmt"
	"time"
)

// RestorePublished seeds restart-safe Discord deliveries before the first
// session snapshot. Only allowlisted channels are restored; unknown records
// remain the delivery layer's responsibility and cannot expand the allowlist.
func (r *Reconciler) RestorePublished(firstSeen map[string]time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.initialized {
		return fmt.Errorf("media: cannot restore published cards after reconciliation starts")
	}
	for rawID, startedAt := range firstSeen {
		channelID := canonicalJellyfinID(rawID)
		channel, allowed := r.cfg.Channels[channelID]
		if !allowed || startedAt.IsZero() {
			continue
		}
		r.channels[channelID] = &trackedChannel{
			observations: r.cfg.ConfirmationPolls,
			published:    true,
			view: ChannelView{
				ChannelID:   channelID,
				ChannelName: channel.DisplayName,
				WatchURL:    channel.WatchURL,
				StartedAt:   startedAt,
			},
		}
	}
	return nil
}
