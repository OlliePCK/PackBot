package style

import (
	"strings"
	"testing"
	"time"

	"github.com/bwmarrin/discordgo"
)

func container(t *testing.T, c discordgo.MessageComponent) discordgo.Container {
	t.Helper()
	cont, ok := c.(discordgo.Container)
	if !ok {
		t.Fatalf("expected Container, got %T", c)
	}
	return cont
}

func textOf(t *testing.T, c discordgo.MessageComponent) string {
	t.Helper()
	switch v := c.(type) {
	case discordgo.TextDisplay:
		return v.Content
	case discordgo.Section:
		var parts []string
		for _, sc := range v.Components {
			parts = append(parts, textOf(t, sc))
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

func allText(t *testing.T, comps []discordgo.MessageComponent) string {
	t.Helper()
	var sb strings.Builder
	for _, c := range comps {
		if cont, ok := c.(discordgo.Container); ok {
			for _, child := range cont.Components {
				sb.WriteString(textOf(t, child))
			}
			continue
		}
		sb.WriteString(textOf(t, c))
	}
	return sb.String()
}

func TestFromEmbedsAccent(t *testing.T) {
	tests := []struct {
		name  string
		color int
		want  int
	}{
		{"explicit color kept", ColorError, ColorError},
		{"zero defaults to brand", 0, ColorBrand},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			comps := FromEmbeds(&discordgo.MessageEmbed{Description: "x", Color: tt.color})
			cont := container(t, comps[0])
			if cont.AccentColor == nil || *cont.AccentColor != tt.want {
				t.Errorf("accent = %v, want %d", cont.AccentColor, tt.want)
			}
		})
	}
}

func TestFromEmbedFieldGrouping(t *testing.T) {
	e := &discordgo.MessageEmbed{Fields: []*discordgo.MessageEmbedField{
		{Name: "Progress", Value: "`bar`\n`0:10 / 3:00`"}, // block (multiline)
		{Name: "Volume", Value: "`100%`", Inline: true},
		{Name: "Loop", Value: "Off", Inline: true},
		{Name: "Requested by", Value: "Ollie", Inline: true},
	}}
	got := allText(t, FromEmbeds(e))
	if !strings.Contains(got, "**Progress**\n`bar`") {
		t.Errorf("block field not name-over-value:\n%s", got)
	}
	if !strings.Contains(got, "**Volume** `100%` · **Loop** Off · **Requested by** Ollie") {
		t.Errorf("inline fields not joined on one line:\n%s", got)
	}
}

func TestFromEmbedHeaderAndFooter(t *testing.T) {
	ts := time.Now().Add(5 * time.Minute)
	e := &discordgo.MessageEmbed{
		Title:       "Poll",
		URL:         "https://example.com",
		Description: "desc",
		Footer:      &discordgo.MessageEmbedFooter{Text: "3 votes • Ends"},
		Timestamp:   ts.Format(time.RFC3339),
	}
	got := allText(t, FromEmbeds(e))
	if !strings.Contains(got, "### [Poll](https://example.com)") {
		t.Errorf("title not rendered as linked heading:\n%s", got)
	}
	if !strings.Contains(got, "-# 3 votes • Ends · <t:") {
		t.Errorf("footer+timestamp not rendered as subtext:\n%s", got)
	}
}

func TestFromEmbedThumbnailBecomesSection(t *testing.T) {
	e := &discordgo.MessageEmbed{
		Title:     "T",
		Thumbnail: &discordgo.MessageEmbedThumbnail{URL: "https://img"},
	}
	cont := container(t, FromEmbeds(e)[0])
	sec, ok := cont.Components[0].(discordgo.Section)
	if !ok {
		t.Fatalf("expected Section first, got %T", cont.Components[0])
	}
	thumb, ok := sec.Accessory.(discordgo.Thumbnail)
	if !ok || thumb.Media.URL != "https://img" {
		t.Errorf("thumbnail accessory wrong: %+v", sec.Accessory)
	}
}

func TestFromEmbedsTruncation(t *testing.T) {
	long := strings.Repeat("🎵", 3000) // runes, not bytes — must not split
	comps := FromEmbeds(
		&discordgo.MessageEmbed{Description: long},
		&discordgo.MessageEmbed{Description: long},
	)
	got := allText(t, comps)
	if n := len([]rune(got)); n > v2TextBudget {
		t.Errorf("total text %d runes exceeds budget %d", n, v2TextBudget)
	}
	if !strings.Contains(got, "…") {
		t.Error("expected truncation ellipsis")
	}
	for _, r := range got {
		if r == '�' {
			t.Fatal("invalid UTF-8 after truncation")
		}
	}
}

func TestFromEmbedsWithRows(t *testing.T) {
	row := discordgo.ActionsRow{Components: []discordgo.MessageComponent{
		discordgo.Button{CustomID: "x", Label: "Vote"},
	}}
	comps := FromEmbedsWithRows(
		[]*discordgo.MessageEmbed{{Description: "poll"}},
		[]discordgo.MessageComponent{row},
	)
	if len(comps) != 1 {
		t.Fatalf("rows should nest inside the container, got %d top-level", len(comps))
	}
	cont := container(t, comps[0])
	if _, ok := cont.Components[len(cont.Components)-1].(discordgo.ActionsRow); !ok {
		t.Errorf("last child should be the ActionsRow, got %T", cont.Components[len(cont.Components)-1])
	}
}
