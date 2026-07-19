package media

import (
	"fmt"
	"net/url"
	"strings"
)

// PublicChannelURL builds a token-free Jellyfin Web link for one stable
// channel item ID. It deliberately links to the authenticated web UI rather
// than a stream endpoint, so no API key or provider URL reaches Discord.
func PublicChannelURL(publicBaseURL, channelID string) (string, error) {
	channelID = CanonicalJellyfinID(channelID)
	if channelID == "" {
		return "", fmt.Errorf("media: Jellyfin channel ID is required")
	}

	publicURL, err := url.Parse(strings.TrimSpace(publicBaseURL))
	if err != nil || publicURL.Scheme != "https" || publicURL.Host == "" {
		return "", fmt.Errorf("media: public Jellyfin URL must be an absolute HTTPS URL")
	}
	if publicURL.User != nil || publicURL.RawQuery != "" || publicURL.Fragment != "" {
		return "", fmt.Errorf(
			"media: public Jellyfin URL must not contain credentials, query, or fragment",
		)
	}

	publicURL.Path = strings.TrimRight(publicURL.Path, "/") + "/web/"
	publicURL.RawPath = ""
	publicURL.Fragment = "/details?id=" + url.QueryEscape(channelID)
	watchURL := publicURL.String()
	if err := validatePublicWatchURL(watchURL); err != nil {
		return "", fmt.Errorf("media: build public Jellyfin watch URL: %w", err)
	}
	return watchURL, nil
}
