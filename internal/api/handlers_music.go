package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

// Music-backed endpoints. All degrade to the Node bot's "no active music
// session" responses when the music manager is nil (Lavalink down) or the
// guild has no voice session.

const noSessionMsg = "No active music session. Start playing from Discord first."

// musicActive reports whether the guild has a live voice session.
func (s *Server) musicActive(guildID string) bool {
	return s.music != nil && s.music.InVoice(guildID)
}

func (s *Server) handleNowPlaying(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if s.music == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"playing": false, "paused": false, "track": nil, "queue": []any{},
			"volume": 100, "hasPrevious": false, "hasNext": false,
		})
		return
	}
	writeJSON(w, http.StatusOK, s.music.APIState(guildID, 10))
}

func (s *Server) handleQueue(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	page := queryInt(r, "page", 1, 0)
	limit := queryInt(r, "limit", 25, 100)

	if s.music == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"currentTrack": nil, "queue": []any{}, "total": 0, "page": 1, "pages": 0,
		})
		return
	}

	current, items := s.music.FullQueue(guildID)
	total := len(items)
	start := min((page-1)*limit, total)
	end := min(start+limit, total)

	writeJSON(w, http.StatusOK, map[string]any{
		"currentTrack": current,
		"queue":        items[start:end],
		"total":        total,
		"page":         page,
		"pages":        (total + limit - 1) / limit,
	})
}

func (s *Server) handleQueueAdd(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if !s.musicActive(guildID) {
		writeError(w, http.StatusBadRequest, noSessionMsg)
		return
	}
	var body struct {
		Query string `json:"query"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Query == "" {
		writeError(w, http.StatusBadRequest, "Query is required")
		return
	}

	track, queueLen, err := s.music.EnqueueQuery(r.Context(), guildID, body.Query, user.ID, "<@"+user.ID+">")
	if err != nil {
		s.log.Error("queue add failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to add track")
		return
	}
	if track == nil {
		writeError(w, http.StatusNotFound, "No tracks found")
		return
	}

	s.log.Info("WEB_QUEUE_ADD", "userId", user.ID, "username", user.Username,
		"guildId", guildID, "track", track.Title, "query", body.Query)

	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"track": map[string]any{
			"title":     track.Title,
			"artist":    track.Artist,
			"duration":  int(track.Duration.Seconds()),
			"thumbnail": track.Thumbnail,
			"position":  queueLen,
		},
	})
}

func (s *Server) handleQueueRemove(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if !s.musicActive(guildID) {
		writeError(w, http.StatusBadRequest, "No active music session")
		return
	}
	pos, err := strconv.Atoi(r.PathValue("position"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid position")
		return
	}
	removed, err := s.music.Guild(guildID).RemoveAt(pos - 1)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid position")
		return
	}

	s.log.Info("WEB_QUEUE_REMOVE", "userId", user.ID, "username", user.Username,
		"guildId", guildID, "position", pos, "removedTrack", removed.Title)

	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"removed": map[string]string{"title": removed.Title, "artist": removed.Artist},
	})
}

func (s *Server) handleQueueMove(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if !s.musicActive(guildID) {
		writeError(w, http.StatusBadRequest, "No active music session")
		return
	}
	var body struct {
		From int `json:"from"`
		To   int `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid body")
		return
	}
	track, err := s.music.Guild(guildID).MoveTrack(body.From-1, body.To-1)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid positions")
		return
	}

	s.log.Info("WEB_QUEUE_MOVE", "userId", user.ID, "username", user.Username,
		"guildId", guildID, "from", body.From, "to", body.To, "track", track.Title)
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (s *Server) handleQueueShuffle(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if !s.musicActive(guildID) {
		writeError(w, http.StatusBadRequest, "No active music session")
		return
	}
	gp := s.music.Guild(guildID)
	if gp.QueueLength() < 2 {
		writeError(w, http.StatusBadRequest, "Need at least 2 songs in queue to shuffle")
		return
	}
	gp.ShuffleQueue()

	s.log.Info("WEB_QUEUE_SHUFFLE", "userId", user.ID, "username", user.Username, "guildId", guildID)
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (s *Server) handleQueueClear(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if !s.musicActive(guildID) {
		writeError(w, http.StatusBadRequest, "No active music session")
		return
	}
	cleared := s.music.Guild(guildID).ClearQueue()

	s.log.Warn("WEB_QUEUE_CLEAR", "userId", user.ID, "username", user.Username,
		"guildId", guildID, "clearedCount", cleared)
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "cleared": cleared})
}

func (s *Server) handlePlayerPause(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if !s.musicActive(guildID) {
		writeError(w, http.StatusBadRequest, "No active music session")
		return
	}
	paused := s.music.Paused(guildID)
	if _, err := s.music.SetPaused(r.Context(), guildID, !paused); err != nil {
		writeError(w, http.StatusBadRequest, "Nothing is playing")
		return
	}
	if paused {
		s.log.Info("WEB_PLAYER_RESUME", "userId", user.ID, "guildId", guildID)
	} else {
		s.log.Info("WEB_PLAYER_PAUSE", "userId", user.ID, "guildId", guildID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "paused": !paused})
}

func (s *Server) handlePlayerSkip(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if !s.musicActive(guildID) {
		writeError(w, http.StatusBadRequest, "No active music session")
		return
	}
	current := s.music.Guild(guildID).CurrentTrack()
	if current == nil {
		writeError(w, http.StatusBadRequest, "Nothing is playing")
		return
	}
	if err := s.music.Skip(r.Context(), guildID, "<@"+user.ID+">"); err != nil {
		writeError(w, http.StatusBadRequest, "Nothing is playing")
		return
	}
	s.log.Info("WEB_PLAYER_SKIP", "userId", user.ID, "guildId", guildID, "skippedTrack", current.Title)
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"skipped": map[string]string{"title": current.Title, "artist": current.Artist},
	})
}

func (s *Server) handlePlayerPrevious(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if !s.musicActive(guildID) {
		writeError(w, http.StatusBadRequest, "No active music session")
		return
	}
	track, err := s.music.Previous(r.Context(), guildID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "No previous track available")
		return
	}
	s.log.Info("WEB_PLAYER_PREVIOUS", "userId", user.ID, "guildId", guildID, "track", track.Title)
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"track":   map[string]string{"title": track.Title, "artist": track.Artist},
	})
}

func (s *Server) handlePlayerSeek(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if !s.musicActive(guildID) {
		writeError(w, http.StatusBadRequest, "No active music session")
		return
	}
	current := s.music.Guild(guildID).CurrentTrack()
	if current == nil {
		writeError(w, http.StatusBadRequest, "Nothing is playing")
		return
	}
	var body struct {
		Time int `json:"time"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Time < 0 {
		writeError(w, http.StatusBadRequest, "Invalid seek time")
		return
	}
	if current.Duration > 0 && float64(body.Time) > current.Duration.Seconds() {
		writeError(w, http.StatusBadRequest, "Seek time exceeds track duration")
		return
	}
	if err := s.music.Seek(r.Context(), guildID, time.Duration(body.Time)*time.Second); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to seek")
		return
	}
	s.log.Info("WEB_PLAYER_SEEK", "userId", user.ID, "guildId", guildID, "time", body.Time)
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "time": body.Time})
}

func (s *Server) handlePlayerStop(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if !s.musicActive(guildID) {
		writeError(w, http.StatusBadRequest, "No active music session")
		return
	}
	if err := s.music.Stop(r.Context(), guildID, "<@"+user.ID+">"); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to stop")
		return
	}
	s.log.Info("WEB_PLAYER_STOP", "userId", user.ID, "guildId", guildID)
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (s *Server) handlePlayerStatus(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	if s.music == nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "idle", "playing": false, "paused": false})
		return
	}
	state := s.music.APIState(guildID, 0)
	status := "idle"
	if state.Playing {
		status = "playing"
		if state.Paused {
			status = "paused"
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      status,
		"playing":     state.Playing && !state.Paused,
		"paused":      state.Paused,
		"hasTrack":    state.Track != nil,
		"hasPrevious": state.HasPrevious,
		"hasNext":     state.HasNext,
	})
}
