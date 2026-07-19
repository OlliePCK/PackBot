package afl

import (
	"net/url"
	"strings"

	"github.com/bwmarrin/discordgo"
)

// KickoffCardWithLink adds a token-free HTTPS Jellyfin navigation button to
// the normal reminder. Invalid or suspicious URLs degrade to the normal card.
func (s *Service) KickoffCardWithLink(match Match, link *WatchLink) []discordgo.MessageComponent {
	card := s.KickoffCard(match)
	if link == nil || !safeWatchURL(link.URL) || len(card) == 0 {
		return card
	}
	container, ok := card[0].(discordgo.Container)
	if !ok {
		return card
	}
	label := strings.TrimSpace(link.Label)
	if label == "" {
		label = "Watch on Jellyfin"
	}
	container.Components = append(container.Components, discordgo.ActionsRow{
		Components: []discordgo.MessageComponent{discordgo.Button{
			Style: discordgo.LinkButton,
			Label: label,
			URL:   link.URL,
			Emoji: &discordgo.ComponentEmoji{Name: "▶️"},
		}},
	})
	card[0] = container
	return card
}

func safeWatchURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return false
	}
	lower := strings.ToLower(raw)
	for _, marker := range []string{"api_key=", "apikey=", "access_token=", "token="} {
		if strings.Contains(lower, marker) {
			return false
		}
	}
	return true
}
