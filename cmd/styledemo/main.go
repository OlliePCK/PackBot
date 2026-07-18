// styledemo posts sample Components-V2 cards to a channel so the styling can
// be eyeballed in Discord without running the whole bot (REST only, no
// gateway). Kept, like cmd/wstest, as a diagnostic tool.
//
// Usage: TOKEN=<bot token> go run ./cmd/styledemo <channelID>
package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/afl"
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

	// linktest mode: isolate where masked links fail to render (live finding:
	// a Section title showed raw [text](url) while a plain TextDisplay didn't).
	if len(os.Args) > 2 && os.Args[2] == "linktest" {
		linkTest(s, channelID)
		return
	}

	// afl mode: full AFL pipeline against the live model API — emoji sync to
	// this app, fetch real predictions, post the round preview + one kickoff
	// ping card. Usage: TOKEN=... styledemo <channelID> afl <appID> <apiURL>
	if len(os.Args) > 4 && os.Args[2] == "afl" {
		aflDemo(s, channelID, os.Args[3], os.Args[4])
		return
	}

	// 1. Converted brand embed with thumbnail, fields, footer + timestamp —
	// exercises the full FromEmbeds mapping (what every command reply uses).
	brand := &discordgo.MessageEmbed{
		Title:       style.Emotes.Play + " | Now playing: Test Track",
		URL:         "https://example.com",
		Description: "The standard command reply, converted from a classic embed.\nEmoji-title link: **[Song 🔥 (Official)](https://example.com)** should render clickable.",
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

// aflDemo runs the real AFL pipeline end to end for visual review.
func aflDemo(s *discordgo.Session, channelID, appID, apiURL string) {
	svc := afl.New(apiURL, nil)
	if err := svc.SyncEmojis(s, appID); err != nil {
		fmt.Fprintln(os.Stderr, "FAIL emoji sync:", err)
		os.Exit(1)
	}
	fmt.Println("ok: club emojis synced")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	matches, err := svc.Predictions(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "FAIL predictions:", err)
		os.Exit(1)
	}
	round, roundMatches := afl.CurrentRound(matches, time.Now())
	fmt.Printf("ok: %d predictions fetched (%s: %d matches)\n", len(matches), round, len(roundMatches))

	if _, err := style.SendComponents(s, channelID, svc.RoundCards(round, roundMatches)); err != nil {
		fmt.Fprintln(os.Stderr, "FAIL round preview:", err)
		os.Exit(1)
	}
	fmt.Println("ok: round preview posted")

	if _, err := style.SendComponents(s, channelID, svc.KickoffCard(roundMatches[0])); err != nil {
		fmt.Fprintln(os.Stderr, "FAIL kickoff card:", err)
		os.Exit(1)
	}
	fmt.Println("ok: kickoff ping card posted")
}

// linkTest posts variants A–E to pinpoint which combination breaks masked
// links: Section vs plain TextDisplay, and emoji/pipe inside vs outside the
// link text.
func linkTest(s *discordgo.Session, channelID string) {
	accent := style.ColorBrand
	thumb := discordgo.Thumbnail{Media: discordgo.UnfurledMediaItem{URL: style.LogoURL}}
	section := func(md string) discordgo.MessageComponent {
		return discordgo.Container{AccentColor: &accent, Components: []discordgo.MessageComponent{
			discordgo.Section{
				Components: []discordgo.MessageComponent{discordgo.TextDisplay{Content: md}},
				Accessory:  thumb,
			},
		}}
	}
	plain := func(md string) discordgo.MessageComponent {
		return discordgo.Container{AccentColor: &accent, Components: []discordgo.MessageComponent{
			discordgo.TextDisplay{Content: md},
		}}
	}
	variants := []discordgo.MessageComponent{
		plain("**F** — emoji inside link, no pipe:\n### [🎵 Test Track](https://example.com)"),
		plain("**G** — pipe inside link, no emoji:\n### [| Test Track](https://example.com)"),
		plain("**H** — emoji mid-text inside link:\n### [Test 🔥 Track](https://example.com)"),
		plain("**I** — bold link, pipe inside:\n**[Test | Track](https://example.com)**"),
		plain("**J** — realistic track title with emoji:\n**[Song 🔥 (Official)](https://example.com)**"),
	}
	_ = section
	payload := struct {
		Components []discordgo.MessageComponent `json:"components"`
		Flags      discordgo.MessageFlags       `json:"flags"`
	}{variants, discordgo.MessageFlagsIsComponentsV2}
	uri := discordgo.EndpointChannelMessages(channelID)
	if _, err := s.RequestWithBucketID("POST", uri, payload, uri); err != nil {
		fmt.Fprintln(os.Stderr, "FAIL linktest:", err)
		os.Exit(1)
	}
	fmt.Println("ok: linktest variants A–E posted")
}
