package trackers

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
)

const liveStatusText = "LIVE STREAMING 🔴"

// LiveNoti announces Discord streams: assigns the guild's live role, posts a
// link embed in the live channel, and sets a "LIVE STREAMING 🔴" status on
// the streamer's voice channel while they stream.
type LiveNoti struct {
	store *storage.Store
	log   *slog.Logger

	mu          sync.Mutex
	isStreaming map[string]bool   // userID → currently streaming
	voiceCh     map[string]string // userID → voice channel with live status set
}

// NewLiveNoti builds the tracker.
func NewLiveNoti(store *storage.Store) *LiveNoti {
	return &LiveNoti{
		store:       store,
		log:         slog.With("tracker", "live-noti"),
		isStreaming: make(map[string]bool),
		voiceCh:     make(map[string]string),
	}
}

// HandlePresenceUpdate reacts to stream start/stop.
func (l *LiveNoti) HandlePresenceUpdate(s *discordgo.Session, p *discordgo.PresenceUpdate) {
	if p.GuildID == "" || p.User == nil {
		return
	}
	userID := p.User.ID

	var streamActivity *discordgo.Activity
	for _, a := range p.Activities {
		if a != nil && a.Type == discordgo.ActivityTypeStreaming {
			streamActivity = a
			break
		}
	}
	nowStreaming := streamActivity != nil

	l.mu.Lock()
	wasStreaming := l.isStreaming[userID]
	if wasStreaming == nowStreaming {
		l.mu.Unlock()
		return
	}
	l.isStreaming[userID] = nowStreaming
	l.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	profile, err := l.store.GuildProfile(ctx, p.GuildID)
	cancel()
	if err != nil {
		l.log.Error("failed to load guild profile", "guild", p.GuildID, "error", err)
		return
	}
	if profile.LiveRoleID == nil || profile.LiveChannelID == nil {
		return // feature not configured for this guild
	}
	roleID, channelID := *profile.LiveRoleID, *profile.LiveChannelID
	username := resolveUsername(s, p.GuildID, p.User)

	if nowStreaming {
		if err := s.GuildMemberRoleAdd(p.GuildID, userID, roleID); err != nil {
			l.log.Warn("couldn't assign live role (check role hierarchy)", "user", userID, "error", err)
			_, _ = s.ChannelMessageSend(channelID, "❌ Couldn't assign live role—check role hierarchy.")
		}

		embed := &discordgo.MessageEmbed{
			Title:  "🔴 " + username + " is now live!",
			Color:  style.ColorBrand,
			Footer: style.Footer(),
		}
		if streamActivity.URL != "" {
			embed.URL = streamActivity.URL
			embed.Description = "Watch here: " + streamActivity.URL
		}
		if _, err := style.Send(s, channelID, "", embed); err != nil {
			l.log.Error("failed to send live notification", "guild", p.GuildID, "error", err)
		}

		// If they're in voice, badge that channel.
		if vs, err := s.State.VoiceState(p.GuildID, userID); err == nil && vs != nil && vs.ChannelID != "" {
			l.mu.Lock()
			l.voiceCh[userID] = vs.ChannelID
			l.mu.Unlock()
			l.setVoiceStatus(s, vs.ChannelID, liveStatusText)
		}
		return
	}

	// Stream stopped.
	if err := s.GuildMemberRoleRemove(p.GuildID, userID, roleID); err != nil {
		l.log.Warn("couldn't remove live role (check role hierarchy)", "user", userID, "error", err)
		_, _ = s.ChannelMessageSend(channelID, "❌ Couldn't remove live role—check role hierarchy.")
	}

	l.mu.Lock()
	oldChannel := l.voiceCh[userID]
	delete(l.voiceCh, userID)
	l.mu.Unlock()
	if oldChannel != "" {
		l.setVoiceStatus(s, oldChannel, "")
	}
}

// HandleVoiceStateUpdate moves the live badge when a streamer changes channel.
func (l *LiveNoti) HandleVoiceStateUpdate(s *discordgo.Session, v *discordgo.VoiceStateUpdate) {
	userID := v.UserID
	l.mu.Lock()
	streaming := l.isStreaming[userID]
	oldChannel := l.voiceCh[userID]
	if !streaming || oldChannel == v.ChannelID {
		l.mu.Unlock()
		return
	}
	if v.ChannelID == "" {
		delete(l.voiceCh, userID)
	} else {
		l.voiceCh[userID] = v.ChannelID
	}
	l.mu.Unlock()

	if oldChannel != "" {
		l.setVoiceStatus(s, oldChannel, "")
	}
	if v.ChannelID != "" {
		l.setVoiceStatus(s, v.ChannelID, liveStatusText)
	}
}

// setVoiceStatus sets/clears the status line shown under a voice channel's
// name. discordgo has no wrapper for this endpoint yet, so this uses a raw
// REST call (PUT /channels/{id}/voice-status).
func (l *LiveNoti) setVoiceStatus(s *discordgo.Session, channelID, status string) {
	endpoint := discordgo.EndpointChannel(channelID) + "/voice-status"
	body := struct {
		Status string `json:"status"`
	}{Status: status}
	if _, err := s.RequestWithBucketID("PUT", endpoint, body, fmt.Sprintf("PUT /channels/%s/voice-status", channelID)); err != nil {
		l.log.Warn("failed to set voice channel status", "channel", channelID, "error", err)
	}
}
