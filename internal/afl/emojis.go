package afl

import (
	"embed"
	"encoding/base64"
	"fmt"
	"log/slog"
	"sync"

	"github.com/bwmarrin/discordgo"
)

// Club logos ship inside the binary (~200KB total) so emoji setup needs no
// filesystem or manual step: SyncEmojis uploads whatever the application is
// missing. Application emojis (up to 2000 per app) work in every guild
// without using anyone's server emoji slots.
//
//go:embed logos/*.png
var logoFS embed.FS

// emojiRegistry maps team name → rendered emoji tag ("<:afl_sydney:123…>").
type emojiRegistry struct {
	mu   sync.RWMutex
	tags map[string]string
}

// SyncEmojis ensures all 18 club logos exist as application emojis and
// records their tags. Failures degrade gracefully — cards render without
// logos until the next sync.
func (s *Service) SyncEmojis(session *discordgo.Session, appID string) error {
	existing, err := session.ApplicationEmojis(appID)
	if err != nil {
		return fmt.Errorf("afl: list application emojis: %w", err)
	}
	byName := make(map[string]*discordgo.Emoji, len(existing))
	for _, e := range existing {
		byName[e.Name] = e
	}

	created := 0
	for _, team := range Teams {
		emoji, ok := byName[team.Emoji]
		if !ok {
			img, err := logoFS.ReadFile("logos/" + team.Emoji + ".png")
			if err != nil {
				return fmt.Errorf("afl: embedded logo %s: %w", team.Emoji, err)
			}
			emoji, err = session.ApplicationEmojiCreate(appID, &discordgo.EmojiParams{
				Name:  team.Emoji,
				Image: "data:image/png;base64," + base64.StdEncoding.EncodeToString(img),
			})
			if err != nil {
				return fmt.Errorf("afl: create emoji %s: %w", team.Emoji, err)
			}
			created++
		}
		s.emojis.mu.Lock()
		s.emojis.tags[team.Name] = "<:" + emoji.Name + ":" + emoji.ID + ">"
		s.emojis.mu.Unlock()
	}
	if created > 0 {
		slog.Info("afl club emojis uploaded", "created", created)
	}
	return nil
}

// EmojiTag returns the club-logo emoji for a team ("" when not synced —
// callers must keep tags OUT of masked-link text; emoji inside link text
// don't render in Components V2).
func (s *Service) EmojiTag(teamName string) string {
	s.emojis.mu.RLock()
	defer s.emojis.mu.RUnlock()
	return s.emojis.tags[teamName]
}
