package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/OlliePCK/packbot/internal/storage"
)

// --- Saved playlists ---

func (s *Server) handlePlaylistsList(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildIDs := make([]string, len(user.Guilds))
	for i, g := range user.Guilds {
		guildIDs[i] = g.ID
	}
	playlists, err := s.store.ListPlaylistsAcrossGuilds(r.Context(), user.ID, guildIDs)
	if err != nil {
		s.log.Error("playlists query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to fetch playlists")
		return
	}
	if playlists == nil {
		playlists = []storage.APIPlaylist{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"playlists": playlists})
}

func (s *Server) handlePlaylistsCreate(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	var body struct {
		GuildID string `json:"guildId"`
		Name    string `json:"name"`
		URL     string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.GuildID == "" || body.Name == "" || body.URL == "" {
		writeError(w, http.StatusBadRequest, "guildId, name and url are required")
		return
	}

	// Parity: the Node endpoint required actual guild membership (no
	// super-admin bypass here).
	member := false
	for _, g := range user.Guilds {
		if g.ID == body.GuildID {
			member = true
			break
		}
	}
	if !member {
		writeError(w, http.StatusForbidden, "No access to this guild")
		return
	}

	platform := "other"
	switch {
	case strings.Contains(body.URL, "spotify.com"):
		platform = "spotify"
	case strings.Contains(body.URL, "youtube.com"), strings.Contains(body.URL, "youtu.be"):
		platform = "youtube"
	case strings.Contains(body.URL, "soundcloud.com"):
		platform = "soundcloud"
	}

	if err := s.store.UpsertPlaylistNoCap(r.Context(), body.GuildID, user.ID, strings.ToLower(body.Name), body.URL, platform); err != nil {
		s.log.Error("playlist create failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to create playlist")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (s *Server) handlePlaylistsDelete(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid playlist id")
		return
	}
	removed, err := s.store.DeletePlaylistByID(r.Context(), id, user.ID)
	if err != nil {
		s.log.Error("playlist delete failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to delete playlist")
		return
	}
	if !removed {
		writeError(w, http.StatusNotFound, "Playlist not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// --- User preferences ---

func (s *Server) handlePreferencesGet(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	fav, err := s.store.FavoriteGuild(r.Context(), user.ID)
	if err != nil {
		s.log.Error("preferences query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to fetch preferences")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"favoriteGuildId": fav})
}

func (s *Server) handlePreferencesPut(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	var body struct {
		FavoriteGuildID *string `json:"favoriteGuildId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid body")
		return
	}
	if body.FavoriteGuildID != nil && !s.hasGuildAccess(user, *body.FavoriteGuildID) {
		writeError(w, http.StatusForbidden, "No access to this guild")
		return
	}
	if err := s.store.SetFavoriteGuild(r.Context(), user.ID, body.FavoriteGuildID); err != nil {
		s.log.Error("preferences update failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to update preferences")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "favoriteGuildId": body.FavoriteGuildID})
}

// --- YouTube watch-list (admin) ---

// requireGuildAdmin mirrors Node: super-admin, or session isAdmin flag on the guild.
func (s *Server) requireGuildAdmin(w http.ResponseWriter, user *SessionUser, guildID string) bool {
	if s.isSuperAdmin(user) {
		return true
	}
	for _, g := range user.Guilds {
		if g.ID == guildID && g.IsAdmin {
			return true
		}
	}
	writeError(w, http.StatusForbidden, "Admin permission required")
	return false
}

func (s *Server) handleYouTubeList(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	watched, err := s.store.ListWatchedChannels(r.Context(), guildID)
	if err != nil {
		s.log.Error("youtube list failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to fetch YouTube channels")
		return
	}

	type channelEntry struct {
		Handle          string  `json:"handle"`
		ChannelID       string  `json:"channelId"`
		Title           *string `json:"title,omitempty"`
		Thumbnail       *string `json:"thumbnail,omitempty"`
		SubscriberCount *string `json:"subscriberCount,omitempty"`
		VideoCount      *string `json:"videoCount,omitempty"`
	}
	channels := []channelEntry{}
	for _, wch := range watched {
		entry := channelEntry{Handle: wch.Handle, ChannelID: wch.ChannelID}
		if s.yt != nil {
			if info, err := s.yt.ChannelByHandle(r.Context(), wch.Handle); err == nil && info != nil {
				entry.Title = &info.Title
				entry.Thumbnail = &info.ThumbnailURL
				entry.SubscriberCount = &info.SubscriberCount
				entry.VideoCount = &info.VideoCount
			}
		}
		channels = append(channels, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": channels})
}

func (s *Server) handleYouTubeAdd(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if !s.requireGuildAdmin(w, user, guildID) {
		return
	}
	if s.yt == nil {
		writeError(w, http.StatusServiceUnavailable, "YouTube API not configured")
		return
	}

	var body struct {
		Handle string `json:"handle"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Handle == "" {
		writeError(w, http.StatusBadRequest, "Handle is required")
		return
	}
	handle := trimHandle(body.Handle)

	channel, err := s.yt.ChannelByHandle(r.Context(), handle)
	if err != nil {
		s.log.Error("youtube channel lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to add YouTube channel")
		return
	}
	if channel == nil {
		writeError(w, http.StatusBadRequest, "Invalid YouTube handle")
		return
	}

	profile, err := s.store.GuildProfile(r.Context(), guildID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to add YouTube channel")
		return
	}
	if profile.YouTubeChannelID == nil || *profile.YouTubeChannelID == "" {
		writeError(w, http.StatusBadRequest, "YouTube notification channel not configured. Set it in Server Settings first.")
		return
	}

	if err := s.store.AddWatchedChannel(r.Context(), handle, channel.ID, guildID); err != nil {
		if storage.IsDuplicateKey(err) {
			writeError(w, http.StatusBadRequest, "Channel already tracked")
			return
		}
		s.log.Error("youtube add failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to add YouTube channel")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"channel": map[string]any{
			"handle":      handle,
			"channelId":   channel.ID,
			"name":        channel.Title,
			"thumbnail":   channel.ThumbnailURL,
			"subscribers": channel.SubscriberCount,
			"videoCount":  channel.VideoCount,
		},
	})
}

func (s *Server) handleYouTubeRemove(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if !s.requireGuildAdmin(w, user, guildID) {
		return
	}
	handle := trimHandle(r.PathValue("handle"))

	removed, err := s.store.RemoveWatchedChannel(r.Context(), handle, guildID)
	if err != nil {
		s.log.Error("youtube remove failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to remove YouTube channel")
		return
	}
	if !removed {
		writeError(w, http.StatusNotFound, "Channel not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// --- Guild settings ---

func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	profile, err := s.store.GuildProfile(r.Context(), guildID)
	if err != nil {
		s.log.Error("settings query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to fetch settings")
		return
	}

	guild, _ := s.discord.State.Guild(guildID)
	guildName := "Unknown"
	if guild != nil {
		guildName = guild.Name
	}

	type ref struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	channelRef := func(id *string) *ref {
		if id == nil || *id == "" {
			return nil
		}
		name := "Unknown"
		if guild != nil {
			for _, ch := range guild.Channels {
				if ch.ID == *id {
					name = ch.Name
					break
				}
			}
		}
		return &ref{ID: *id, Name: name}
	}
	roleRef := func(id *string) *ref {
		if id == nil || *id == "" {
			return nil
		}
		name := "Unknown"
		if guild != nil {
			for _, role := range guild.Roles {
				if role.ID == *id {
					name = role.Name
					break
				}
			}
		}
		return &ref{ID: *id, Name: name}
	}

	availableChannels := []ref{}
	availableRoles := []ref{}
	if guild != nil {
		for _, ch := range guild.Channels {
			if ch.Type == 0 || ch.Type == 5 { // text / announcement
				availableChannels = append(availableChannels, ref{ID: ch.ID, Name: ch.Name})
			}
		}
		for _, role := range guild.Roles {
			if !role.Managed && role.Name != "@everyone" {
				availableRoles = append(availableRoles, ref{ID: role.ID, Name: role.Name})
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"guildId":             guildID,
		"guildName":           guildName,
		"liveRole":            roleRef(profile.LiveRoleID),
		"liveChannel":         channelRef(profile.LiveChannelID),
		"generalChannel":      channelRef(profile.GeneralChannelID),
		"youtubeChannel":      channelRef(profile.YouTubeChannelID),
		"twentyFourSevenMode": profile.TwentyFourSevenMode,
		"availableChannels":   availableChannels,
		"availableRoles":      availableRoles,
	})
}

// settingsColumns maps API setting names to Guilds columns (starboard and
// voice-command settings dropped with their features).
var settingsColumns = map[string]string{
	"liveRole":            "liveRoleID",
	"liveChannel":         "liveChannelID",
	"generalChannel":      "generalChannelID",
	"youtubeChannel":      "youtubeChannelID",
	"twentyFourSevenMode": "twentyFourSevenMode",
}

func (s *Server) handleSettingsPut(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if !s.requireGuildAdmin(w, user, guildID) {
		return
	}

	var body struct {
		Setting string `json:"setting"`
		Value   any    `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid body")
		return
	}
	column, ok := settingsColumns[body.Setting]
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid setting")
		return
	}

	var dbValue any
	if body.Setting == "twentyFourSevenMode" {
		enabled := false
		if b, ok := body.Value.(bool); ok {
			enabled = b
		}
		if enabled {
			dbValue = 1
		} else {
			dbValue = 0
		}
	} else {
		// Channel/role ID string; empty clears (Node: dbValue || null).
		str, _ := body.Value.(string)
		if str == "" {
			dbValue = nil
		} else {
			dbValue = str
		}
	}

	if err := s.store.UpdateGuildSetting(r.Context(), guildID, column, dbValue); err != nil {
		s.log.Error("settings update failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to update setting")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "setting": body.Setting, "value": dbValue})
}
