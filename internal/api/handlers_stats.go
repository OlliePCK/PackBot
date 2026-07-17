package api

import (
	"net/http"
	"strings"
)

func (s *Server) handleLeaderboard(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	game := r.URL.Query().Get("game")
	limit := queryInt(r, "limit", 25, 100)

	type entry struct {
		Rank         int    `json:"rank"`
		UserID       string `json:"odUserId"`
		Username     string `json:"username"`
		GameName     string `json:"gameName"`
		TotalSeconds int64  `json:"totalSeconds"`
		Formatted    string `json:"formatted"`
	}

	var entries []entry
	if game != "" {
		rows, err := s.store.TopPlaytimeForGame(r.Context(), guildID, game, limit)
		if err != nil {
			s.log.Error("leaderboard query failed", "error", err)
			writeError(w, http.StatusInternalServerError, "Failed to fetch leaderboard")
			return
		}
		for i, row := range rows {
			entries = append(entries, entry{
				Rank: i + 1, UserID: row.UserID, Username: row.Username,
				GameName: game, TotalSeconds: row.TotalSeconds,
				Formatted: formatAPIPlaytime(row.TotalSeconds),
			})
		}
	} else {
		rows, err := s.store.TopPlaytimeTotal(r.Context(), guildID, limit)
		if err != nil {
			s.log.Error("leaderboard query failed", "error", err)
			writeError(w, http.StatusInternalServerError, "Failed to fetch leaderboard")
			return
		}
		for i, row := range rows {
			entries = append(entries, entry{
				Rank: i + 1, UserID: row.UserID, Username: row.Username,
				GameName: "All Games", TotalSeconds: row.TotalSeconds,
				Formatted: formatAPIPlaytime(row.TotalSeconds),
			})
		}
	}

	games, err := s.store.GameNames(r.Context(), guildID)
	if err != nil {
		s.log.Error("game list query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to fetch leaderboard")
		return
	}

	displayGame := game
	if displayGame == "" {
		displayGame = "all"
	}
	if entries == nil {
		entries = []entry{}
	}
	if games == nil {
		games = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"guildId": guildID, "game": displayGame, "leaderboard": entries, "games": games,
	})
}

func (s *Server) handleLeaderboardUser(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	targetID := r.PathValue("odUserId")

	rows, username, err := s.store.UserPlaytimeWithName(r.Context(), guildID, targetID)
	if err != nil {
		s.log.Error("user playtime query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to fetch user stats")
		return
	}
	if username == "" {
		username = "Unknown"
	}

	type gameEntry struct {
		Name       string `json:"name"`
		Seconds    int64  `json:"seconds"`
		Formatted  string `json:"formatted"`
		LastPlayed string `json:"lastPlayed"`
	}
	var total int64
	games := []gameEntry{}
	for _, row := range rows {
		total += row.TotalSeconds
		games = append(games, gameEntry{
			Name: row.GameName, Seconds: row.TotalSeconds,
			Formatted:  formatAPIPlaytime(row.TotalSeconds),
			LastPlayed: row.LastPlayed.Format("2006-01-02T15:04:05Z07:00"),
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"odUserId": targetID, "username": username,
		"totalSeconds": total, "totalFormatted": formatAPIPlaytime(total),
		"games": games,
	})
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	page := queryInt(r, "page", 1, 0)
	limit := queryInt(r, "limit", 50, 100)
	userFilter := r.URL.Query().Get("userId")

	entries, total, err := s.store.HistoryPage(r.Context(), guildID, userFilter, page, limit)
	if err != nil {
		s.log.Error("history query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to fetch history")
		return
	}

	type item struct {
		ID          int64          `json:"id"`
		Title       string         `json:"title"`
		Artist      *string        `json:"artist"`
		URL         *string        `json:"url"`
		Thumbnail   *string        `json:"thumbnail"`
		Duration    int            `json:"duration"`
		RequestedBy map[string]any `json:"requestedBy"`
		PlayedAt    string         `json:"playedAt"`
	}
	history := []item{}
	for _, e := range entries {
		history = append(history, item{
			ID: e.ID, Title: e.Title, Artist: e.Artist, URL: e.URL,
			Thumbnail: e.Thumbnail, Duration: e.Duration,
			RequestedBy: map[string]any{"id": e.UserID, "username": e.Username},
			PlayedAt:    e.PlayedAt.Format("2006-01-02T15:04:05Z07:00"),
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"history": history, "total": total, "page": page, "pages": (total + limit - 1) / limit,
	})
}

func (s *Server) handleHistoryStats(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	stats, err := s.store.HistoryStats(r.Context(), r.PathValue("guildId"))
	if err != nil {
		s.log.Error("history stats query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to fetch history stats")
		return
	}
	if stats.TopTracks == nil {
		stats.TopTracks = []storageAPITrack{}
	}
	if stats.TopUsers == nil {
		stats.TopUsers = []storageAPIUserPlays{}
	}
	if stats.HourlyActivity == nil {
		stats.HourlyActivity = []storageHourCount{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"totalTracks":        stats.TotalTracks,
		"totalListeningTime": stats.TotalSeconds,
		"topTracks":          stats.TopTracks,
		"topUsers":           stats.TopUsers,
		"hourlyActivity":     stats.HourlyActivity,
	})
}

func (s *Server) handleProfile(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	targetID := r.PathValue("userId")
	guildIDs, ok := s.profileGuildScope(w, r, user)
	if !ok {
		return
	}

	ctx := r.Context()
	stats, err := s.store.UserProfileStats(ctx, targetID, guildIDs)
	if err != nil {
		s.log.Error("profile stats failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to fetch profile")
		return
	}
	username, _ := s.store.LatestUsername(ctx, targetID)
	if username == "" {
		username = "Unknown User"
	}
	topTracks, err := s.store.TopTracksAPI(ctx, guildIDs, targetID, 10)
	if err != nil {
		s.log.Error("profile top tracks failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to fetch profile")
		return
	}
	topArtists, err := s.store.TopArtistsAPI(ctx, guildIDs, targetID, 10)
	if err != nil {
		s.log.Error("profile top artists failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to fetch profile")
		return
	}
	recent, err := s.store.RecentPlays(ctx, guildIDs, targetID, 20)
	if err != nil {
		s.log.Error("profile recent plays failed", "error", err)
		writeError(w, http.StatusInternalServerError, "Failed to fetch profile")
		return
	}

	type badge struct {
		Name string `json:"name"`
		Icon string `json:"icon"`
		Desc string `json:"desc"`
	}
	badges := []badge{}
	if stats.TotalTracks >= 100 {
		badges = append(badges, badge{"Centurion", "💯", "100+ tracks played"})
	}
	if stats.TotalTracks >= 500 {
		badges = append(badges, badge{"Audiophile", "🎧", "500+ tracks played"})
	}
	if stats.TotalTracks >= 1000 {
		badges = append(badges, badge{"Music Legend", "🏆", "1000+ tracks played"})
	}
	if stats.TotalSeconds >= 86400 {
		badges = append(badges, badge{"Day Tripper", "☀️", "24+ hours of music"})
	}
	if stats.TotalSeconds >= 604800 {
		badges = append(badges, badge{"Week Warrior", "⚔️", "168+ hours of music"})
	}
	if stats.GuildsActive >= 3 {
		badges = append(badges, badge{"Nomad", "🌍", "Active in 3+ servers"})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"userId":   targetID,
		"username": username,
		"stats": map[string]any{
			"totalTracks":        stats.TotalTracks,
			"totalListeningTime": stats.TotalSeconds,
			"guildsActive":       stats.GuildsActive,
		},
		"topTracks":   emptyIfNilTracks(topTracks),
		"topArtists":  emptyIfNilArtists(topArtists),
		"recentPlays": emptyIfNilRecent(recent),
		"badges":      badges,
	})
}

// profileGuildScope resolves the guild set for profile queries: one guild
// (with access check) when ?guildId= is given, else all accessible guilds.
func (s *Server) profileGuildScope(w http.ResponseWriter, r *http.Request, user *SessionUser) ([]string, bool) {
	if guildID := r.URL.Query().Get("guildId"); guildID != "" {
		if !s.hasGuildAccess(user, guildID) {
			writeError(w, http.StatusForbidden, "No access to this guild")
			return nil, false
		}
		return []string{guildID}, true
	}
	return s.userGuildIDs(user), true
}

func (s *Server) handleCompatibility(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	userID := r.PathValue("userId")
	otherID := r.PathValue("otherUserId")
	guildIDs, ok := s.profileGuildScope(w, r, user)
	if !ok {
		return
	}

	ctx := r.Context()
	artists1, err := s.store.TopArtistsAPI(ctx, guildIDs, userID, 50)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to compute compatibility")
		return
	}
	artists2, err := s.store.TopArtistsAPI(ctx, guildIDs, otherID, 50)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to compute compatibility")
		return
	}

	set1 := make(map[string]bool, len(artists1))
	for _, a := range artists1 {
		set1[strings.ToLower(a.Artist)] = true
	}
	set2 := make(map[string]bool, len(artists2))
	for _, a := range artists2 {
		set2[strings.ToLower(a.Artist)] = true
	}
	shared := []string{}
	for a := range set1 {
		if set2[a] {
			shared = append(shared, a)
		}
	}
	minSize := min(len(set1), len(set2))
	compat := 0
	if minSize > 0 {
		compat = int(float64(len(shared))/float64(minSize)*100 + 0.5)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"compatibility":    compat,
		"sharedArtists":    shared,
		"user1ArtistCount": len(set1),
		"user2ArtistCount": len(set2),
	})
}

func (s *Server) handleWrappedServer(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	ctx := r.Context()

	stats, err := s.store.GuildWrappedStats(ctx, guildID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to fetch server stats")
		return
	}
	topTracks, err := s.store.TopTracksAPI(ctx, []string{guildID}, "", 5)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to fetch server stats")
		return
	}
	listeners, err := s.store.MusicLeaderboard(ctx, guildID, 5)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to fetch server stats")
		return
	}
	topArtists, err := s.store.TopArtistsAPI(ctx, []string{guildID}, "", 5)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to fetch server stats")
		return
	}

	type listener struct {
		UserID       string `json:"odUserId"`
		Username     string `json:"username"`
		PlayCount    int    `json:"playCount"`
		TotalSeconds int64  `json:"totalSeconds"`
	}
	topListeners := []listener{}
	for _, l := range listeners {
		topListeners = append(topListeners, listener{
			UserID: l.UserID, Username: l.Username, PlayCount: l.PlayCount, TotalSeconds: l.TotalSeconds,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"stats": map[string]any{
			"totalTracks":   stats.TotalTracks,
			"totalSeconds":  stats.TotalSeconds,
			"uniqueArtists": stats.UniqueArtists,
		},
		"topTracks":    emptyIfNilTracks(topTracks),
		"topListeners": topListeners,
		"topArtists":   emptyIfNilArtists(topArtists),
	})
}

func (s *Server) handleWrappedUser(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	targetID := r.PathValue("userId")
	ctx := r.Context()

	stats, err := s.store.UserWrappedStats(ctx, guildID, targetID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to fetch user stats")
		return
	}
	username, _ := s.store.LatestUsername(ctx, targetID)
	if username == "" {
		username = "Unknown"
	}
	topTracks, err := s.store.TopTracksAPI(ctx, []string{guildID}, targetID, 5)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to fetch user stats")
		return
	}
	topArtists, err := s.store.TopArtistsAPI(ctx, []string{guildID}, targetID, 5)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to fetch user stats")
		return
	}
	hour, err := s.store.FavoriteHour(ctx, guildID, targetID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to fetch user stats")
		return
	}
	var favoriteHour *int
	if hour >= 0 {
		favoriteHour = &hour
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"userId":   targetID,
		"username": username,
		"stats": map[string]any{
			"totalTracks":  stats.TotalTracks,
			"totalSeconds": stats.TotalSeconds,
			"uniqueTracks": stats.UniqueTracks,
		},
		"topTracks":    emptyIfNilTracks(topTracks),
		"topArtists":   emptyIfNilArtists(topArtists),
		"favoriteHour": favoriteHour,
	})
}

func (s *Server) handleWrappedCompare(w http.ResponseWriter, r *http.Request, user *SessionUser) {
	guildID := r.PathValue("guildId")
	id1, id2 := r.PathValue("userId1"), r.PathValue("userId2")
	ctx := r.Context()

	type side struct {
		stats    map[string]any
		tracks   []storageAPITrack
		artists  []storageArtistPlays
		username string
	}
	load := func(uid string) (*side, error) {
		stats, err := s.store.UserWrappedStats(ctx, guildID, uid)
		if err != nil {
			return nil, err
		}
		username, _ := s.store.LatestUsername(ctx, uid)
		if username == "" {
			username = "Unknown"
		}
		tracks, err := s.store.TopTracksAPI(ctx, []string{guildID}, uid, 50)
		if err != nil {
			return nil, err
		}
		artists, err := s.store.TopArtistsAPI(ctx, []string{guildID}, uid, 30)
		if err != nil {
			return nil, err
		}
		return &side{
			stats: map[string]any{
				"totalTracks":  stats.TotalTracks,
				"totalSeconds": stats.TotalSeconds,
			},
			tracks: tracks, artists: artists, username: username,
		}, nil
	}

	u1, err := load(id1)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to compare users")
		return
	}
	u2, err := load(id2)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to compare users")
		return
	}

	trackKey := func(t storageAPITrack) string {
		artist := ""
		if t.Artist != nil {
			artist = *t.Artist
		}
		return strings.ToLower(t.Title + "::" + artist)
	}
	tracks1 := make(map[string]bool)
	for _, t := range u1.tracks {
		tracks1[trackKey(t)] = true
	}
	sharedTracks := 0
	for _, t := range u2.tracks {
		if tracks1[trackKey(t)] {
			sharedTracks++
		}
	}

	artists1 := make(map[string]bool)
	for _, a := range u1.artists {
		artists1[strings.ToLower(a.Artist)] = true
	}
	artists2 := make(map[string]bool)
	for _, a := range u2.artists {
		artists2[strings.ToLower(a.Artist)] = true
	}
	shared := []string{}
	for a := range artists1 {
		if artists2[a] {
			shared = append(shared, a)
		}
	}
	minArtists := min(len(artists1), len(artists2))
	compat := 0
	if minArtists > 0 {
		compat = int(float64(len(shared))/float64(minArtists)*100 + 0.5)
	}

	sideJSON := func(id string, u *side) map[string]any {
		return map[string]any{
			"userId":       id,
			"username":     u.username,
			"totalTracks":  u.stats["totalTracks"],
			"totalSeconds": u.stats["totalSeconds"],
			"topTracks":    emptyIfNilTracks(firstTracks(u.tracks, 5)),
			"topArtists":   emptyIfNilArtists(firstArtists(u.artists, 5)),
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"user1":         sideJSON(id1, u1),
		"user2":         sideJSON(id2, u2),
		"compatibility": compat,
		"sharedTracks":  sharedTracks,
		"sharedArtists": shared,
	})
}
