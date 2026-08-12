package jobs

import (
	"strings"
	"testing"

	"github.com/OlliePCK/packbot/internal/minecraft"
)

func TestLogEmbedsBatchRoutineEventsIntoOneCard(t *testing.T) {
	embeds := mcLogEmbeds([]mcCard{
		{kind: minecraft.EventJoin, player: "Ollie", text: "+ Ollie joined"},
		{kind: minecraft.EventAdvancement, player: "Ollie", text: "earned Sweet Dreams"},
		{kind: minecraft.EventLeave, player: "Ollie", text: "- Ollie left"},
	})
	if len(embeds) != 1 {
		t.Fatalf("want 1 batched embed, got %d", len(embeds))
	}
	if n := strings.Count(embeds[0].Description, "\n"); n != 2 {
		t.Errorf("want 3 lines in one card, got %d newlines", n)
	}
	if embeds[0].Footer != nil {
		t.Error("event cards must not carry a footer")
	}
}

func TestLogEmbedsGiveDeathsTheirOwnCard(t *testing.T) {
	embeds := mcLogEmbeds([]mcCard{
		{kind: minecraft.EventJoin, player: "Ollie", text: "+ Ollie joined"},
		{kind: minecraft.EventDeath, player: "Ollie", text: "Ollie was slain", location: "`1, 2, 3` · overworld"},
	})
	if len(embeds) != 2 {
		t.Fatalf("want a separate death card, got %d embeds", len(embeds))
	}
	death := embeds[0]
	if death.Color != mcColorDeath {
		t.Errorf("death card colour = %#x, want %#x", death.Color, mcColorDeath)
	}
	if !strings.Contains(death.Description, "1, 2, 3") {
		t.Errorf("death card should show coordinates, got %q", death.Description)
	}
	if death.Author == nil || death.Author.IconURL == "" {
		t.Error("death card should carry the player's head")
	}
}

func TestLogEmbedsColourByMostNotableEvent(t *testing.T) {
	embeds := mcLogEmbeds([]mcCard{
		{kind: minecraft.EventLeave, player: "Ollie", text: "left"},
		{kind: minecraft.EventAdvancement, player: "Ollie", text: "first!", first: true},
		{kind: minecraft.EventJoin, player: "Ollie", text: "joined"},
	})
	if embeds[0].Color != mcColorFirst {
		t.Errorf("batch colour = %#x, want first-to-earn %#x", embeds[0].Color, mcColorFirst)
	}
}

// A card naming several people should not be attributed to one of them.
func TestLogEmbedsOnlyAttributeSinglePlayerBatches(t *testing.T) {
	mixed := mcLogEmbeds([]mcCard{
		{kind: minecraft.EventJoin, player: "Ollie", text: "a"},
		{kind: minecraft.EventJoin, player: "Rin", text: "b"},
	})
	if mixed[0].Author != nil {
		t.Error("multi-player batch should have no author")
	}

	single := mcLogEmbeds([]mcCard{
		{kind: minecraft.EventJoin, player: "Ollie", text: "a"},
	})
	if single[0].Author == nil || single[0].Author.Name != "Ollie" {
		t.Error("single-player batch should be attributed")
	}
}

func TestFormatDeathLocation(t *testing.T) {
	x, y, z := -412, 63, 1180
	if got := formatDeathLocation(&x, &y, &z, "minecraft:overworld"); got != "`-412, 63, 1180` · overworld" {
		t.Errorf("got %q", got)
	}
	if got := formatDeathLocation(&x, &y, &z, "minecraft:the_nether"); got != "`-412, 63, 1180` · the nether" {
		t.Errorf("got %q", got)
	}
	// A player who dies and quits immediately leaves no position behind.
	if got := formatDeathLocation(nil, nil, nil, ""); got != "" {
		t.Errorf("want empty for missing coordinates, got %q", got)
	}
}

// Player names reach this code from a parsed log file, so they must never be
// interpolated into the avatar URL unchecked.
func TestAuthorRejectsUnsafeNamesForAvatarURL(t *testing.T) {
	for _, name := range []string{"../../etc", "a b", "Ollie/../x", ""} {
		if a := mcAuthor(name); a.IconURL != "" {
			t.Errorf("mcAuthor(%q) built an icon URL: %q", name, a.IconURL)
		}
	}
	if a := mcAuthor("OlliePCK"); !strings.HasSuffix(a.IconURL, "/OlliePCK/64") {
		t.Errorf("valid name should get an avatar, got %q", a.IconURL)
	}
}
