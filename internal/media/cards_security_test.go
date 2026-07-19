package media

import (
	"strings"
	"testing"
	"time"

	"github.com/bwmarrin/discordgo"
)

func TestLiveTVCardSanitizesDiscordMentionsAndMarkdown(t *testing.T) {
	components := LiveTVCard(ChannelView{
		ChannelName: "@here _Fox_",
		ProgramName: "<@123456789> [click](https://attacker.invalid) `code`",
		Viewers:     []string{"@everyone *owner*"},
		StartedAt:   time.Unix(1_753_000_000, 0),
		WatchURL:    "https://jellyfin.example/web/#/details?id=channel",
	})

	if len(components) != 1 {
		t.Fatalf("top-level components = %d, want 1", len(components))
	}
	container, ok := components[0].(discordgo.Container)
	if !ok {
		t.Fatalf("top-level component = %T, want discordgo.Container", components[0])
	}
	var text strings.Builder
	var linkURL string
	for _, child := range container.Components {
		switch component := child.(type) {
		case discordgo.TextDisplay:
			text.WriteString(component.Content)
			text.WriteByte('\n')
		case discordgo.ActionsRow:
			for _, rowChild := range component.Components {
				if button, ok := rowChild.(discordgo.Button); ok {
					linkURL = button.URL
				}
			}
		}
	}

	rendered := text.String()
	for _, unsafe := range []string{"@everyone", "@here", "<@123456789>", "*owner*", "_Fox_", "[click]"} {
		if strings.Contains(rendered, unsafe) {
			t.Errorf("rendered card contains unsafe raw text %q: %q", unsafe, rendered)
		}
	}
	for _, safe := range []string{
		"@\u200beveryone",
		"@\u200bhere",
		"<@\u200b123456789>",
		`\*owner\*`,
		`\_Fox\_`,
		`\[click\]`,
		"\\`code\\`",
	} {
		if !strings.Contains(rendered, safe) {
			t.Errorf("rendered card missing sanitized text %q: %q", safe, rendered)
		}
	}
	if linkURL != "https://jellyfin.example/web/#/details?id=channel" {
		t.Errorf("button URL = %q", linkURL)
	}
}

func TestViewerHeadlineNeverEmitsRawMention(t *testing.T) {
	got := viewerHeadline([]string{"@everyone", "@here"})
	if strings.Contains(got, "@everyone") || strings.Contains(got, "@here") {
		t.Fatalf("viewer headline contains raw mention: %q", got)
	}
	if !strings.Contains(got, "@\u200beveryone") || !strings.Contains(got, "@\u200bhere") {
		t.Errorf("viewer headline did not preserve readable sanitized aliases: %q", got)
	}
}
