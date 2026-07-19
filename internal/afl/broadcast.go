package afl

import "context"

// WatchLink is optional, public, token-free Jellyfin navigation attached only
// to the configured friends guild's five-minute reminder.
type WatchLink struct {
	URL         string
	Label       string
	ChannelName string
}

// BroadcastResolver resolves a match independently for each guild. The media
// implementation returns nil outside its immutable main-guild boundary.
type BroadcastResolver interface {
	ResolveAFL(context.Context, string, Match) (*WatchLink, error)
}

// SetBroadcastResolver installs the optional resolver before Run starts.
func (s *Service) SetBroadcastResolver(resolver BroadcastResolver) {
	s.broadcastResolver = resolver
}
