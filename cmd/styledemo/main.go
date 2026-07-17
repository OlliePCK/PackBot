// styledemo posts sample Components-V2 cards to a channel so the styling can
// be eyeballed in Discord without running the whole bot (REST only, no
// gateway). Kept, like cmd/wstest, as a diagnostic tool.
//
// Usage: TOKEN=<bot token> go run ./cmd/styledemo <channelID>
package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/style"
)

func main() {
	token := os.Getenv("TOKEN")
	if token == "" || len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: TOKEN=<bot token> styledemo <channelID>")
		os.Exit(1)
	}
	channelID := os.Args[1]

	s, err := discordgo.New("Bot " + token)
	if err != nil {
		fmt.Fprintln(os.Stderr, "session:", err)
		os.Exit(1)
	}

	// 1. Converted brand embed with thumbnail, fields, footer + timestamp —
	// exercises the full FromEmbeds mapping (what every command reply uses).
	brand := &discordgo.MessageEmbed{
		Title:       style.Emotes.Play + " | Now playing: Test Track",
		URL:         "https://example.com",
		Description: "The standard command reply, converted from a classic embed.",
		Color:       style.ColorBrand,
		Footer:      style.Footer(),
		Thumbnail:   &discordgo.MessageEmbedThumbnail{URL: style.LogoURL},
		Timestamp:   time.Now().Add(4 * time.Minute).Format(time.RFC3339),
		Fields: []*discordgo.MessageEmbedField{
			{Name: "Duration", Value: "`3:45`", Inline: true},
			{Name: "Requested by", Value: "Ollie", Inline: true},
			{Name: "Volume", Value: "`100%`", Inline: true},
			{Name: "Progress", Value: "`───●────────────────`\n`0:45 / 3:45`"},
		},
	}

	// 2. Error card.
	errCard := style.ErrorEmbed("Something went wrong — the standard error card.")

	// 3. Poll-style card with (disabled) buttons attached inside the card.
	poll := &discordgo.MessageEmbed{
		Title:       "Poll",
		Description: "**Best filter?**\n\n**1.** Slowed + Reverb\n████████░░ 4 votes (80%)\n\n**2.** Earrape\n██░░░░░░░░ 1 vote (20%)",
		Color:       style.ColorBrand,
		Footer:      &discordgo.MessageEmbedFooter{Text: "5 votes • Ends"},
		Timestamp:   time.Now().Add(10 * time.Minute).Format(time.RFC3339),
	}
	pollRows := []discordgo.MessageComponent{discordgo.ActionsRow{Components: []discordgo.MessageComponent{
		discordgo.Button{CustomID: "demo_1", Label: "Slowed + Reverb", Style: discordgo.PrimaryButton, Disabled: true},
		discordgo.Button{CustomID: "demo_2", Label: "Earrape", Style: discordgo.PrimaryButton, Disabled: true},
	}}}

	// 4. Truncation sample — must send fine despite exceeding the V2 budget.
	long := &discordgo.MessageEmbed{
		Title:       "Leaderboard-sized content",
		Description: strings.Repeat("`1.` SomePlayer — 3d 8h 0m\n", 300),
		Color:       style.ColorBrand,
		Footer:      style.Footer(),
	}

	steps := []struct {
		name string
		send func() error
	}{
		{"brand card", func() error { _, e := style.Send(s, channelID, "", brand); return e }},
		{"error card", func() error { _, e := style.Send(s, channelID, "", errCard); return e }},
		{"poll card + buttons", func() error {
			comps := style.FromEmbedsWithRows([]*discordgo.MessageEmbed{poll}, pollRows)
			payload := struct {
				Components []discordgo.MessageComponent `json:"components"`
				Flags      discordgo.MessageFlags       `json:"flags"`
			}{comps, discordgo.MessageFlagsIsComponentsV2}
			uri := discordgo.EndpointChannelMessages(channelID)
			_, e := s.RequestWithBucketID("POST", uri, payload, uri)
			return e
		}},
		{"lead text + card (mention line)", func() error {
			_, e := style.Send(s, channelID, "🔔 New video: https://youtu.be/dQw4w9WgXcQ", &discordgo.MessageEmbed{
				Title: "Video Title", URL: "https://youtu.be/dQw4w9WgXcQ",
				Description: "**Channel** uploaded a new video!",
				Color:       style.ColorBrand, Footer: style.Footer(),
			})
			return e
		}},
		{"truncation card", func() error { _, e := style.Send(s, channelID, "", long); return e }},
	}
	for _, step := range steps {
		if err := step.send(); err != nil {
			fmt.Fprintf(os.Stderr, "FAIL %s: %v\n", step.name, err)
			os.Exit(1)
		}
		fmt.Println("ok:", step.name)
	}
}
