package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

func loadMedia() Media {
	media := Media{
		Enabled:           boolEnv("MEDIA_ENABLED", false),
		GuildID:           strings.TrimSpace(os.Getenv("MEDIA_GUILD_ID")),
		JellyfinURL:       strings.TrimRight(strings.TrimSpace(os.Getenv("JELLYFIN_URL")), "/"),
		JellyfinPublicURL: strings.TrimRight(strings.TrimSpace(os.Getenv("JELLYFIN_PUBLIC_URL")), "/"),
		JellyfinAPIKey:    strings.TrimSpace(os.Getenv("JELLYFIN_API_KEY")),
		AFLChannelIDs:     splitCSV(os.Getenv("MEDIA_AFL_CHANNEL_IDS")),
	}

	var err error
	if media.PollInterval, err = durationEnv("MEDIA_POLL_INTERVAL", 15*time.Second); err != nil {
		media.ValidationError = err
		return media
	}
	if media.AnnounceDelay, err = durationEnv("MEDIA_ANNOUNCE_DELAY", 15*time.Second); err != nil {
		media.ValidationError = err
		return media
	}
	if media.StopGrace, err = durationEnv("MEDIA_STOP_GRACE", 30*time.Second); err != nil {
		media.ValidationError = err
		return media
	}
	if !media.Enabled {
		return media
	}

	for name, value := range map[string]string{
		"MEDIA_GUILD_ID":      media.GuildID,
		"JELLYFIN_URL":        media.JellyfinURL,
		"JELLYFIN_PUBLIC_URL": media.JellyfinPublicURL,
		"JELLYFIN_API_KEY":    media.JellyfinAPIKey,
	} {
		if value == "" {
			media.ValidationError = fmt.Errorf("config: %s is required when MEDIA_ENABLED=true", name)
			return media
		}
	}
	if media.PollInterval < 5*time.Second {
		media.ValidationError = fmt.Errorf("config: MEDIA_POLL_INTERVAL must be at least 5s")
		return media
	}
	if media.AnnounceDelay < media.PollInterval {
		media.ValidationError = fmt.Errorf("config: MEDIA_ANNOUNCE_DELAY must be at least MEDIA_POLL_INTERVAL")
		return media
	}
	if media.StopGrace < media.PollInterval {
		media.ValidationError = fmt.Errorf("config: MEDIA_STOP_GRACE must be at least MEDIA_POLL_INTERVAL")
		return media
	}

	media.ViewerAliases, err = stringMapJSON("MEDIA_USER_ALIASES_JSON")
	if err != nil {
		media.ValidationError = err
		return media
	}
	media.ViewerAliases, err = canonicalJellyfinMap(media.ViewerAliases, "MEDIA_USER_ALIASES_JSON")
	if err != nil {
		media.ValidationError = err
		return media
	}
	if len(media.ViewerAliases) == 0 {
		media.ValidationError = fmt.Errorf(
			"config: MEDIA_USER_ALIASES_JSON must allowlist at least one Jellyfin user",
		)
		return media
	}
	media.Channels, err = stringMapJSON("MEDIA_CHANNELS_JSON")
	if err != nil {
		media.ValidationError = err
		return media
	}
	media.Channels, err = canonicalJellyfinMap(media.Channels, "MEDIA_CHANNELS_JSON")
	if err != nil {
		media.ValidationError = err
		return media
	}
	// An empty MEDIA_CHANNELS_JSON surfaces ALL Live TV channels — the
	// single-connection occupancy alert. A non-empty map restricts to those
	// channels and supplies curated display names (and then the AFL channels
	// must be within it).
	for index, channelID := range media.AFLChannelIDs {
		channelID = canonicalJellyfinConfigID(channelID)
		media.AFLChannelIDs[index] = channelID
		if len(media.Channels) > 0 {
			if _, ok := media.Channels[channelID]; !ok {
				media.ValidationError = fmt.Errorf(
					"config: MEDIA_AFL_CHANNEL_IDS contains a channel not present in MEDIA_CHANNELS_JSON",
				)
				return media
			}
		}
	}
	return media
}

func durationEnv(name string, def time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return def, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("config: invalid %s duration", name)
	}
	return value, nil
}

func stringMapJSON(name string) (map[string]string, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return nil, nil
	}
	var values map[string]string
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil, fmt.Errorf("config: invalid %s JSON: %w", name, err)
	}
	clean := make(map[string]string, len(values))
	for key, value := range values {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key == "" || value == "" {
			return nil, fmt.Errorf("config: %s keys and values must be non-empty", name)
		}
		clean[key] = value
	}
	return clean, nil
}

func splitCSV(raw string) []string {
	var values []string
	seen := make(map[string]bool)
	for _, value := range strings.Split(raw, ",") {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		values = append(values, value)
	}
	return values
}
