// Components-V2 cards. Discord's 2025 component system replaces embeds with
// composable layout blocks (Container/Section/TextDisplay/MediaGallery/
// Separator) — a message carrying MessageFlagsIsComponentsV2 may not have
// content or embeds at all. PackBot renders every reply as one accent-striped
// Container per former embed.
//
// FromEmbeds is the migration bridge: command/job code keeps building classic
// MessageEmbed values (familiar shape, easy parity with the Node bot) and the
// send boundaries convert them here. Bespoke layouts (e.g. /nowplaying's
// control card) build component trees directly instead.

package style

import (
	"fmt"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"
)

// v2TextBudget caps total text across a message's TextDisplays. Discord's
// hard limit is 4000 characters (embeds allowed 6000, so long content like
// /leaderboard pages must truncate rather than 400 the whole reply).
const v2TextBudget = 3900

// FromEmbeds converts classic embeds into Components-V2 containers, one per
// embed, sharing a single text budget.
func FromEmbeds(embeds ...*discordgo.MessageEmbed) []discordgo.MessageComponent {
	budget := v2TextBudget
	out := make([]discordgo.MessageComponent, 0, len(embeds))
	for _, e := range embeds {
		if e == nil {
			continue
		}
		out = append(out, fromEmbed(e, &budget))
	}
	return out
}

// FromEmbedsWithRows converts embeds and attaches interactive rows (buttons,
// selects) inside the final container so they read as part of the card.
func FromEmbedsWithRows(embeds []*discordgo.MessageEmbed, rows []discordgo.MessageComponent) []discordgo.MessageComponent {
	comps := FromEmbeds(embeds...)
	if len(rows) == 0 {
		return comps
	}
	if len(comps) == 0 {
		return rows
	}
	last, ok := comps[len(comps)-1].(discordgo.Container)
	if !ok {
		return append(comps, rows...)
	}
	last.Components = append(last.Components, rows...)
	comps[len(comps)-1] = last
	return comps
}

func fromEmbed(e *discordgo.MessageEmbed, budget *int) discordgo.MessageComponent {
	accent := e.Color
	if accent == 0 {
		accent = ColorBrand
	}
	var children []discordgo.MessageComponent

	// Header: author (small), title (heading, masked link when URL set),
	// description — one text block, promoted to a Section when a thumbnail
	// should sit beside it.
	var head []string
	if e.Author != nil && e.Author.Name != "" {
		head = append(head, "-# "+e.Author.Name)
	}
	if e.Title != "" {
		if e.URL != "" {
			head = append(head, fmt.Sprintf("### [%s](%s)", e.Title, e.URL))
		} else {
			head = append(head, "### "+e.Title)
		}
	}
	if e.Description != "" {
		head = append(head, e.Description)
	}
	headText := takeText(strings.Join(head, "\n"), budget)
	if headText != "" {
		if e.Thumbnail != nil && e.Thumbnail.URL != "" {
			children = append(children, discordgo.Section{
				Components: []discordgo.MessageComponent{discordgo.TextDisplay{Content: headText}},
				Accessory:  discordgo.Thumbnail{Media: discordgo.UnfurledMediaItem{URL: e.Thumbnail.URL}},
			})
		} else {
			children = append(children, discordgo.TextDisplay{Content: headText})
		}
	}

	if fieldsText := takeText(renderFields(e.Fields), budget); fieldsText != "" {
		children = append(children, discordgo.TextDisplay{Content: fieldsText})
	}

	if e.Image != nil && e.Image.URL != "" {
		children = append(children, discordgo.MediaGallery{
			Items: []discordgo.MediaGalleryItem{{Media: discordgo.UnfurledMediaItem{URL: e.Image.URL}}},
		})
	}

	// Footer + timestamp → subtext; timestamps upgrade to live-updating
	// relative form ("Ends · in 4 minutes" counts down, unlike embeds).
	foot := ""
	if e.Footer != nil {
		foot = e.Footer.Text
	}
	if e.Timestamp != "" {
		if t, err := time.Parse(time.RFC3339, e.Timestamp); err == nil {
			ts := fmt.Sprintf("<t:%d:R>", t.Unix())
			if foot != "" {
				foot += " · " + ts
			} else {
				foot = ts
			}
		}
	}
	if foot = takeText(foot, budget); foot != "" {
		divider := true
		small := discordgo.SeparatorSpacingSizeSmall
		children = append(children,
			discordgo.Separator{Divider: &divider, Spacing: &small},
			discordgo.TextDisplay{Content: "-# " + foot},
		)
	}

	if len(children) == 0 {
		children = append(children, discordgo.TextDisplay{Content: "​"})
	}
	return discordgo.Container{AccentColor: &accent, Components: children}
}

// renderFields lays fields out as text: consecutive inline fields join on one
// line (up to 3, echoing the embed grid), block fields get name-over-value.
func renderFields(fields []*discordgo.MessageEmbedField) string {
	var lines []string
	var run []string
	flush := func() {
		if len(run) > 0 {
			lines = append(lines, strings.Join(run, " · "))
			run = nil
		}
	}
	for _, f := range fields {
		if f == nil {
			continue
		}
		if f.Inline && !strings.Contains(f.Value, "\n") {
			run = append(run, fmt.Sprintf("**%s** %s", f.Name, f.Value))
			if len(run) == 3 {
				flush()
			}
			continue
		}
		flush()
		lines = append(lines, fmt.Sprintf("**%s**\n%s", f.Name, f.Value))
	}
	flush()
	return strings.Join(lines, "\n")
}

// takeText spends budget on s, truncating rune-safely (byte slicing could
// split an emoji into invalid UTF-8, which Discord rejects).
func takeText(s string, budget *int) string {
	if s == "" {
		return ""
	}
	if *budget <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) > *budget {
		r = append(r[:*budget-1], '…')
	}
	*budget -= len(r)
	return string(r)
}
