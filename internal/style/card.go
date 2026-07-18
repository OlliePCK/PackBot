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
	"regexp"
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
		head = append(head, "### "+MaskedLink(e.Title, e.URL))
	}
	if e.Description != "" {
		head = append(head, sanitizeMaskedLinks(e.Description))
	}
	headText := takeText(strings.Join(head, "\n"), budget)
	hasThumb := e.Thumbnail != nil && e.Thumbnail.URL != ""
	// Beside a thumbnail, fields stack one per line to spend the artwork's
	// height; full-width cards join inline runs three-up like the embed grid.
	fieldsText := takeText(sanitizeMaskedLinks(renderFields(e.Fields, hasThumb)), budget)

	// With a thumbnail, head AND fields share the Section (up to 3 text
	// blocks) so the text column fills the space beside the artwork — a
	// title-only section leaves a mostly-empty row at thumbnail height.
	if hasThumb && (headText != "" || fieldsText != "") {
		var texts []discordgo.MessageComponent
		for _, t := range []string{headText, fieldsText} {
			if t != "" {
				texts = append(texts, discordgo.TextDisplay{Content: t})
			}
		}
		children = append(children, discordgo.Section{
			Components: texts,
			Accessory:  discordgo.Thumbnail{Media: discordgo.UnfurledMediaItem{URL: e.Thumbnail.URL}},
		})
	} else {
		if headText != "" {
			children = append(children, discordgo.TextDisplay{Content: headText})
		}
		if fieldsText != "" {
			children = append(children, discordgo.TextDisplay{Content: fieldsText})
		}
	}

	if e.Image != nil && e.Image.URL != "" {
		children = append(children, discordgo.MediaGallery{
			Items: []discordgo.MediaGalleryItem{{Media: discordgo.UnfurledMediaItem{URL: e.Image.URL}}},
		})
	}

	// Footer + timestamp → subtext; timestamps upgrade to live-updating
	// relative form ("Ends · in 4 minutes" counts down, unlike embeds).
	// The bare brand footer is dropped: Discord already shows the app name
	// on every message, and the divider+subtext just bulked out small cards
	// (live styling feedback). Footers carrying real info still render.
	foot := ""
	if e.Footer != nil && !(e.Footer.Text == FooterText && e.Timestamp == "") {
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

// renderFields lays fields out as text. stacked puts every inline field on
// its own line (for thumbnail sections, filling the artwork's height);
// otherwise consecutive inline fields join up to 3 per line, echoing the
// embed grid. Block (multiline/non-inline) fields get name-over-value.
func renderFields(fields []*discordgo.MessageEmbedField, stacked bool) string {
	perLine := 3
	if stacked {
		perLine = 1
	}
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
			if len(run) == perLine {
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

var maskedLinkRe = regexp.MustCompile(`\[([^\]\n]*)\]\((https?://[^)\s]+)\)`)

// MaskedLink builds a [text](url) link that Discord's V2 text parser will
// actually render: emoji anywhere inside masked-link text silently break the
// link (verified live against the API — the raw brackets show instead), so
// leading emoji hoist outside the brackets and interior emoji are stripped.
// Square brackets in the text are escaped so titles can't break the syntax.
func MaskedLink(text, url string) string {
	if url == "" {
		return text
	}
	text = strings.NewReplacer("[", `\[`, "]", `\]`).Replace(text)
	return sanitizeMaskedLinks("[" + text + "](" + url + ")")
}

// sanitizeMaskedLinks rewrites every masked link in md whose text contains
// emoji (see MaskedLink). Applied to converted descriptions and fields too,
// since commands compose links over arbitrary track/video titles.
func sanitizeMaskedLinks(md string) string {
	return maskedLinkRe.ReplaceAllStringFunc(md, func(m string) string {
		sub := maskedLinkRe.FindStringSubmatch(m)
		text, url := sub[1], sub[2]
		if !strings.ContainsFunc(text, isEmojiRune) {
			return m
		}

		// Hoist the leading emoji/pipe run out of the brackets.
		runes := []rune(text)
		cut := 0
		for cut < len(runes) && (isEmojiRune(runes[cut]) || runes[cut] == '|' || runes[cut] == ' ') {
			cut++
		}
		prefix, rest := string(runes[:cut]), string(runes[cut:])

		// Strip whatever emoji remain mid-text; collapse doubled spaces.
		rest = strings.Join(strings.Fields(strings.Map(func(r rune) rune {
			if isEmojiRune(r) {
				return -1
			}
			return r
		}, rest)), " ")

		if rest == "" {
			return strings.TrimSpace(prefix) // all-emoji text: keep it, lose the link
		}
		return prefix + "[" + rest + "](" + url + ")"
	})
}

// isEmojiRune covers the symbol blocks Discord renders as emoji. Bounded
// ranges only — a blanket r >= 0x1F000 would eat CJK Extension B titles.
func isEmojiRune(r rune) bool {
	switch {
	case r >= 0x1F000 && r <= 0x1FAFF: // emoji, flags, transport, supplemental
		return true
	case r >= 0x2600 && r <= 0x27BF: // misc symbols, dingbats
		return true
	case r >= 0x2B00 && r <= 0x2BFF: // arrows/stars (⭐)
		return true
	case r >= 0x2300 && r <= 0x23FF: // media/tech (⏭ ⌚)
		return true
	case r >= 0x25A0 && r <= 0x25FF: // geometric (▶)
		return true
	case r >= 0x2190 && r <= 0x21FF: // arrows
		return true
	case r == 0xFE0F || r == 0x200D || r == 0x20E3: // VS-16, ZWJ, keycap
		return true
	}
	return false
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
