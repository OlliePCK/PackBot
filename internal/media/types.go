// Package media contains the privacy boundary and state machine for the
// main-guild Live TV integration. Discord delivery and process wiring live
// outside this package.
package media

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode"
)

// LiveTVSession is the intentionally minimal output of the Jellyfin client.
// ViewerID is an opaque lookup key for the configured public alias; it must
// never be rendered directly.
type LiveTVSession struct {
	ViewerID    string
	ChannelID   string
	ChannelName string
	ProgramID   string
	ProgramName string
}

// UnknownViewerPolicy controls sessions whose Jellyfin user ID is not in the
// configured alias allowlist.
type UnknownViewerPolicy uint8

const (
	// IgnoreUnknownViewers omits unknown viewers and their otherwise-empty
	// channel groups entirely.
	IgnoreUnknownViewers UnknownViewerPolicy = iota
	// AnonymizeUnknownViewers includes unknown viewers as "Someone" without
	// exposing their Jellyfin identity.
	AnonymizeUnknownViewers
)

// ChannelConfig is safe, user-facing metadata for one allowlisted Jellyfin
// channel. The map key in Config.Channels is the Jellyfin channel item ID.
type ChannelConfig struct {
	DisplayName string
	WatchURL    string
}

// Config defines the only guild and Discord destination that the media core
// may target. It deliberately has no fallback guild or channel.
type Config struct {
	MainGuildID      string
	GeneralChannelID string

	// ViewerAliases maps Jellyfin user IDs to safe public names.
	ViewerAliases       map[string]string
	UnknownViewerPolicy UnknownViewerPolicy

	// Channels maps Jellyfin channel item IDs to safe public metadata. When
	// AllowAllChannels is false, any channel not present here is ignored.
	Channels map[string]ChannelConfig

	// AllowAllChannels surfaces every active Live TV channel rather than only
	// the curated ones — the single-connection "the tuner is occupied" alert.
	// Non-curated channels take their display name from the Jellyfin session
	// and a generated token-free watch URL, so PublicBaseURL is required.
	AllowAllChannels bool
	// PublicBaseURL builds watch URLs for non-curated channels in
	// AllowAllChannels mode (the same public HTTPS Jellyfin base as the
	// curated channels' URLs).
	PublicBaseURL string

	// ConfirmationPolls is the number of consecutive snapshots required before
	// a new channel lifecycle produces an upsert. It must be at least two.
	ConfirmationPolls int
	// EndAfterMissingPolls is the number of consecutive absent snapshots before
	// a published lifecycle produces an end intent.
	EndAfterMissingPolls int
}

// IntentKind tells the delivery layer whether to create/update the active card
// or finish the published lifecycle.
type IntentKind string

const (
	IntentEnd    IntentKind = "end"
	IntentUpsert IntentKind = "upsert"
)

// Intent is safe to pass to Discord delivery: it contains aliases and curated
// channel metadata, never Jellyfin user IDs or provider details.
type Intent struct {
	Kind                 IntentKind
	MainGuildID          string
	DestinationChannelID string
	Channel              ChannelView
	At                   time.Time
}

// ChannelView is the current public representation of one active channel.
type ChannelView struct {
	ChannelID   string
	ChannelName string
	WatchURL    string
	ProgramID   string
	ProgramName string
	Viewers     []string
	StartedAt   time.Time
}

func normalizeConfig(cfg Config) (Config, error) {
	cfg.MainGuildID = strings.TrimSpace(cfg.MainGuildID)
	cfg.GeneralChannelID = strings.TrimSpace(cfg.GeneralChannelID)
	if cfg.MainGuildID == "" {
		return Config{}, fmt.Errorf("media: main guild ID is required")
	}
	if cfg.GeneralChannelID == "" {
		return Config{}, fmt.Errorf("media: general channel ID is required")
	}
	if cfg.ConfirmationPolls < 2 {
		return Config{}, fmt.Errorf("media: confirmation polls must be at least 2")
	}
	if cfg.EndAfterMissingPolls < 1 {
		return Config{}, fmt.Errorf("media: end-after-missing polls must be at least 1")
	}
	if cfg.UnknownViewerPolicy != IgnoreUnknownViewers && cfg.UnknownViewerPolicy != AnonymizeUnknownViewers {
		return Config{}, fmt.Errorf("media: invalid unknown viewer policy")
	}

	aliases := make(map[string]string, len(cfg.ViewerAliases))
	for userID, alias := range cfg.ViewerAliases {
		userID = canonicalJellyfinID(userID)
		alias = cleanText(alias)
		if userID == "" || alias == "" {
			return Config{}, fmt.Errorf("media: viewer aliases must have non-empty IDs and names")
		}
		aliases[userID] = alias
	}
	cfg.ViewerAliases = aliases

	cfg.PublicBaseURL = strings.TrimSpace(cfg.PublicBaseURL)
	if cfg.AllowAllChannels {
		// Every channel needs a generated watch URL, so the public base must
		// be valid up front rather than failing per-channel at runtime.
		if _, err := PublicChannelURL(cfg.PublicBaseURL, "validation"); err != nil {
			return Config{}, fmt.Errorf("media: public base URL is required to allow all channels: %w", err)
		}
	} else if len(cfg.Channels) == 0 {
		return Config{}, fmt.Errorf("media: at least one channel must be allowlisted")
	}
	channels := make(map[string]ChannelConfig, len(cfg.Channels))
	for channelID, channel := range cfg.Channels {
		channelID = canonicalJellyfinID(channelID)
		channel.DisplayName = cleanText(channel.DisplayName)
		channel.WatchURL = strings.TrimSpace(channel.WatchURL)
		if channelID == "" || channel.DisplayName == "" {
			return Config{}, fmt.Errorf("media: channel IDs and display names must be non-empty")
		}
		if err := validatePublicWatchURL(channel.WatchURL); err != nil {
			return Config{}, fmt.Errorf("media: channel %q: %w", channelID, err)
		}
		channels[channelID] = channel
	}
	cfg.Channels = channels
	return cfg, nil
}

func validatePublicWatchURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return fmt.Errorf("watch URL must be an absolute HTTPS URL")
	}
	if u.User != nil {
		return fmt.Errorf("watch URL must not contain credentials")
	}
	lower := strings.ToLower(raw)
	for _, marker := range []string{"api_key=", "apikey=", "access_token=", "token="} {
		if strings.Contains(lower, marker) {
			return fmt.Errorf("watch URL must not contain an access token")
		}
	}
	return nil
}

func cleanText(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, value)
	return strings.TrimSpace(value)
}

func sortIntents(intents []Intent) {
	sort.Slice(intents, func(i, j int) bool {
		if intents[i].Kind != intents[j].Kind {
			return intents[i].Kind == IntentEnd
		}
		return intents[i].Channel.ChannelID < intents[j].Channel.ChannelID
	})
}
