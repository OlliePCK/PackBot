package media

import (
	"fmt"
	"strings"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/style"
)

// LiveTVCard renders one editable Components-V2 card per active channel.
func LiveTVCard(view ChannelView) []discordgo.MessageComponent {
	viewerCount := len(view.Viewers)
	children := []discordgo.MessageComponent{
		discordgo.TextDisplay{Content: "### 📺 " + viewerHeadline(view.Viewers)},
	}

	channelName := safeDiscordText(view.ChannelName)
	programName := safeDiscordText(view.ProgramName)
	switch {
	case programName != "" && channelName != "":
		children = append(children, discordgo.TextDisplay{
			Content: fmt.Sprintf("**%s** on **%s**", programName, channelName),
		})
	case channelName != "":
		children = append(children, discordgo.TextDisplay{Content: "**" + channelName + "**"})
	}

	meta := fmt.Sprintf("%d %s · shared live channel", viewerCount, plural(viewerCount, "viewer", "viewers"))
	if !view.StartedAt.IsZero() {
		meta = fmt.Sprintf("<t:%d:R> · %s", view.StartedAt.Unix(), meta)
	}
	children = append(children, discordgo.TextDisplay{Content: "-# " + meta})

	if view.WatchURL != "" {
		children = append(children, discordgo.ActionsRow{
			Components: []discordgo.MessageComponent{discordgo.Button{
				Style: discordgo.LinkButton,
				Label: "Join on Jellyfin",
				URL:   view.WatchURL,
				Emoji: &discordgo.ComponentEmoji{Name: "▶️"},
			}},
		})
	}

	accent := style.ColorBrand
	return []discordgo.MessageComponent{discordgo.Container{
		AccentColor: &accent,
		Components:  children,
	}}
}

func viewerHeadline(viewers []string) string {
	if len(viewers) == 0 {
		return "Someone is watching live TV"
	}
	allAnonymous := true
	for _, viewer := range viewers {
		if viewer != "Someone" {
			allAnonymous = false
			break
		}
	}
	if allAnonymous {
		if len(viewers) == 1 {
			return "Someone is watching live TV"
		}
		return fmt.Sprintf("%d friends are watching live TV", len(viewers))
	}

	names := make([]string, 0, min(len(viewers), 3))
	for _, viewer := range viewers {
		names = append(names, safeDiscordText(viewer))
		if len(names) == 3 {
			break
		}
	}
	var subject string
	switch {
	case len(viewers) == 1:
		subject = names[0]
	case len(viewers) == 2:
		subject = names[0] + " and " + names[1]
	case len(viewers) == 3:
		subject = names[0] + ", " + names[1] + " and " + names[2]
	default:
		subject = fmt.Sprintf("%s, %s + %d more", names[0], names[1], len(viewers)-2)
	}
	verb := "are"
	if len(viewers) == 1 {
		verb = "is"
	}
	return fmt.Sprintf("%s %s watching live TV", subject, verb)
}

func plural(n int, singular, plural string) string {
	if n == 1 {
		return singular
	}
	return plural
}

func safeDiscordText(value string) string {
	value = cleanText(value)
	const maxRunes = 100
	runes := []rune(value)
	if len(runes) > maxRunes {
		value = string(runes[:maxRunes-1]) + "\u2026"
	}

	value = strings.ReplaceAll(value, "@", "@\u200b")
	replacer := strings.NewReplacer(
		`\`, `\\`,
		"*", `\*`,
		"_", `\_`,
		"~", `\~`,
		"`", "\\`",
		"[", `\[`,
		"]", `\]`,
	)
	return replacer.Replace(value)
}
