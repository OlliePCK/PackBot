package afl

import (
	"testing"
	"time"

	"github.com/bwmarrin/discordgo"
)

func TestKickoffCardWithLink(t *testing.T) {
	service := New("https://model.example", nil)
	match := Match{
		GameID: "38653", Home: "Sydney", Away: "Adelaide",
		Round: "Round 19", Venue: "S.C.G.",
		Kickoff: time.Date(2026, 7, 19, 9, 40, 0, 0, time.UTC),
		Winner:  "Sydney", HomeProb: 0.59, Margin: 4,
	}
	card := service.KickoffCardWithLink(match, &WatchLink{
		URL:   "https://jellyfin.example/web/#/details?id=channel",
		Label: "Join on Jellyfin",
	})
	container, ok := card[0].(discordgo.Container)
	if !ok {
		t.Fatalf("card[0] = %T, want Container", card[0])
	}
	row, ok := container.Components[len(container.Components)-1].(discordgo.ActionsRow)
	if !ok || len(row.Components) != 1 {
		t.Fatalf("last component = %#v, want one-button row", container.Components[len(container.Components)-1])
	}
	button, ok := row.Components[0].(discordgo.Button)
	if !ok || button.Style != discordgo.LinkButton || button.URL == "" {
		t.Fatalf("button = %#v", row.Components[0])
	}
}

func TestKickoffCardRejectsUnsafeWatchURL(t *testing.T) {
	service := New("https://model.example", nil)
	match := Match{
		Home: "Sydney", Away: "Adelaide", Round: "Round 19",
		Kickoff: time.Now(), Winner: "Sydney", HomeProb: 0.5,
	}
	for _, raw := range []string{
		"http://jellyfin.example/watch",
		"https://jellyfin.example/watch?api_key=secret",
		"https://user:pass@jellyfin.example/watch",
	} {
		card := service.KickoffCardWithLink(match, &WatchLink{URL: raw})
		container := card[0].(discordgo.Container)
		for _, component := range container.Components {
			if _, ok := component.(discordgo.ActionsRow); ok {
				t.Errorf("unsafe URL %q produced an action row", raw)
			}
		}
	}
}
