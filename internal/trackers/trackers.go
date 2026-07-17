// Package trackers holds the presence-driven background listeners (Node:
// events/event-functions/): game playtime tracking and live-stream
// notifications.
//
// Porting note: discord.js hands presenceUpdate handlers both the old and new
// presence from its cache; discordgo events carry only the new presence, so
// each tracker keeps its own last-seen state map — which is what the Node
// code effectively did anyway (its startTimes/isStreaming maps).
package trackers

import (
	"github.com/bwmarrin/discordgo"
)

// resolveUsername best-effort resolves a user's name from presence data,
// state cache, or REST (presence payloads often carry only the user ID).
func resolveUsername(s *discordgo.Session, guildID string, user *discordgo.User) string {
	if user != nil && user.Username != "" {
		return user.Username
	}
	if user == nil {
		return "Unknown"
	}
	if member, err := s.State.Member(guildID, user.ID); err == nil && member.User != nil && member.User.Username != "" {
		return member.User.Username
	}
	if fetched, err := s.User(user.ID); err == nil && fetched.Username != "" {
		return fetched.Username
	}
	return "Unknown"
}
