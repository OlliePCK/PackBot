package afl

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/style"
)

const aflHeaderEmoji = "🏉"

// RoundCards renders the weekly round preview: a brand header followed by one
// accent-striped card per match in the home team's colours.
func (s *Service) RoundCards(round string, matches []Match) []discordgo.MessageComponent {
	accent := style.ColorBrand
	comps := []discordgo.MessageComponent{discordgo.Container{
		AccentColor: &accent,
		Components: []discordgo.MessageComponent{
			discordgo.TextDisplay{Content: fmt.Sprintf("### %s %s — Model Tips", aflHeaderEmoji, round)},
			discordgo.TextDisplay{Content: "-# The Pack · refreshed after team announcements · not betting advice"},
		},
	}}
	for _, m := range matches {
		comps = append(comps, s.matchContainer(m, false))
	}
	return comps
}

// KickoffCard renders the pre-game ping for one match.
func (s *Service) KickoffCard(m Match) []discordgo.MessageComponent {
	return []discordgo.MessageComponent{s.matchContainer(m, true)}
}

func (s *Service) matchContainer(m Match, kickoffPing bool) discordgo.MessageComponent {
	accent := style.ColorBrand
	if t, ok := Teams[m.Home]; ok {
		accent = t.Accent
	}

	title := fmt.Sprintf("%s **%s** v **%s** %s",
		s.EmojiTag(m.Home), m.Home, m.Away, s.EmojiTag(m.Away))
	if kickoffPing {
		title = fmt.Sprintf("### %s About to bounce!\n%s", aflHeaderEmoji, title)
	}

	line2 := fmt.Sprintf("-# %s · <t:%d:R>", m.Venue, m.Kickoff.Unix())
	tip := fmt.Sprintf("**Tip: %s** by %.0f · %s %.0f%%",
		m.Winner, math.Abs(m.Margin), probBar(m.WinnerProb()), m.WinnerProb()*100)
	if m.HomeOdds > 0 && m.AwayOdds > 0 {
		tip += fmt.Sprintf("\n-# market: %s $%.2f · %s $%.2f", m.Home, m.HomeOdds, m.Away, m.AwayOdds)
	}

	return discordgo.Container{
		AccentColor: &accent,
		Components: []discordgo.MessageComponent{
			discordgo.TextDisplay{Content: title + "\n" + line2},
			discordgo.TextDisplay{Content: tip},
		},
	}
}

// probBar renders win probability as ▰▰▰▰▰▰▱▱▱▱ over ten segments.
func probBar(p float64) string {
	filled := int(math.Round(p * 10))
	filled = max(0, min(filled, 10))
	return strings.Repeat("▰", filled) + strings.Repeat("▱", 10-filled)
}

// CurrentRound picks the round to feature: the round of the earliest match
// that hasn't started (falling back to the last round in the data), plus its
// matches. Matches already played still show — the weekly post covers the
// whole round.
func CurrentRound(matches []Match, now time.Time) (string, []Match) {
	if len(matches) == 0 {
		return "", nil
	}
	round := matches[len(matches)-1].Round
	for _, m := range matches {
		if m.Kickoff.After(now) {
			round = m.Round
			break
		}
	}
	var out []Match
	for _, m := range matches {
		if m.Round == round {
			out = append(out, m)
		}
	}
	return round, out
}
