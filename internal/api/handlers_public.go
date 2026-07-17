package api

import (
	"net/http"
	"sort"
	"time"
)

// apiVersion is reported by /api/stats (Node reported package.json's 1.0.0).
const apiVersion = "2.0.0-go"

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	guilds := s.discord.State.Guilds
	users := 0
	for _, g := range guilds {
		users += g.MemberCount
	}
	uptime := time.Since(s.startedAt)

	activeVoice := 0
	if s.music != nil {
		activeVoice = s.music.ActiveVoiceCount()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":          "online",
		"guilds":          len(guilds),
		"users":           users,
		"uptime":          uptime.Seconds(),
		"uptimeFormatted": formatUptime(uptime),
		"ping":            s.discord.HeartbeatLatency().Milliseconds(),
		"activeVoice":     activeVoice,
		"version":         apiVersion,
	})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"online":    s.discord.DataReady,
		"timestamp": time.Now().UnixMilli(),
	})
}

func (s *Server) handleGuilds(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	type guildEntry struct {
		ID          string  `json:"id"`
		Name        string  `json:"name"`
		MemberCount int     `json:"memberCount"`
		Icon        *string `json:"icon"`
		IsAdmin     bool    `json:"isAdmin"`
	}

	isSuperAdmin := s.isSuperAdmin(user)
	var guilds []guildEntry

	if isSuperAdmin {
		for _, g := range s.discord.State.Guilds {
			guilds = append(guilds, guildEntry{
				ID: g.ID, Name: g.Name, MemberCount: g.MemberCount,
				Icon: guildIconURL(g.ID, g.Icon), IsAdmin: true,
			})
		}
	} else {
		for _, g := range user.Guilds {
			memberCount := 0
			if cached, err := s.discord.State.Guild(g.ID); err == nil {
				memberCount = cached.MemberCount
			}
			guilds = append(guilds, guildEntry{
				ID: g.ID, Name: g.Name, MemberCount: memberCount,
				Icon: guildIconURL(g.ID, g.Icon), IsAdmin: g.IsAdmin,
			})
		}
	}

	sort.Slice(guilds, func(a, b int) bool { return guilds[a].MemberCount > guilds[b].MemberCount })
	if guilds == nil {
		guilds = []guildEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"guilds": guilds, "isSuperAdmin": isSuperAdmin})
}

// Music-backed endpoints live in handlers_music.go.
