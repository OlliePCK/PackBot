// Package api is PackBot's web API (Node: api/WebAPI.js) — the REST backend
// for PackSite. Built on net/http with Go 1.22 method+pattern routing; no
// web framework needed.
//
// Porting notes:
//   - Quotes/starboard endpoints are gone with those features.
//   - The Socket.io realtime layer only carries music state, so it ships
//     with the music batch (as plain WebSocket).
//   - Music-backed endpoints (/nowplaying, /queue, /player) return their
//     "no active session" shapes until the music system lands; the Music
//     interface below is their future hook.
package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/config"
	"github.com/OlliePCK/packbot/internal/music"
	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/youtube"
)

// Server is the web API server.
type Server struct {
	cfg      config.API
	store    *storage.Store
	discord  *discordgo.Session
	yt       *youtube.Client
	sessions *sessionStore
	music    *music.Manager // nil while Lavalink is unavailable
	ws       *wsHub

	startedAt time.Time
	log       *slog.Logger
}

// New builds the server. musicManager may be nil (music endpoints then
// answer with their no-session shapes).
func New(cfg config.API, store *storage.Store, discord *discordgo.Session, yt *youtube.Client, musicManager *music.Manager) *Server {
	s := &Server{
		cfg:       cfg,
		store:     store,
		discord:   discord,
		yt:        yt,
		sessions:  newSessionStore(store),
		music:     musicManager,
		ws:        newWSHub(),
		startedAt: time.Now(),
		log:       slog.With("component", "api"),
	}
	if musicManager != nil {
		musicManager.OnUpdate(s.pushMusicUpdate)
	}
	return s
}

// Run serves until ctx is cancelled, then shuts down gracefully.
func (s *Server) Run(ctx context.Context) error {
	server := &http.Server{
		Addr:              ":" + s.cfg.Port,
		Handler:           s.logMiddleware(s.corsMiddleware(s.routes())),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go s.sessions.cleanupLoop(ctx)

	errCh := make(chan error, 1)
	go func() {
		s.log.Info("web API server running", "port", s.cfg.Port)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return fmt.Errorf("api: serve: %w", err)
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("api: shutdown: %w", err)
		}
		s.log.Info("web API server stopped")
		return nil
	}
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	// Public
	mux.HandleFunc("GET /api/stats", s.handleStats)
	mux.HandleFunc("GET /api/status", s.handleStatus)

	// OAuth
	mux.HandleFunc("GET /api/auth/discord", s.handleAuthRedirect)
	mux.HandleFunc("GET /api/auth/callback", s.handleAuthCallback)
	mux.HandleFunc("GET /api/auth/me", s.handleAuthMe)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)

	// Guilds
	mux.HandleFunc("GET /api/guilds", s.requireAuth(s.handleGuilds))

	// Music
	mux.HandleFunc("GET /api/nowplaying/{guildId}", s.requireGuild(s.handleNowPlaying))
	mux.HandleFunc("GET /api/queue/{guildId}", s.requireGuild(s.handleQueue))
	mux.HandleFunc("POST /api/queue/{guildId}/add", s.requireGuild(s.handleQueueAdd))
	mux.HandleFunc("DELETE /api/queue/{guildId}/{position}", s.requireGuild(s.handleQueueRemove))
	mux.HandleFunc("POST /api/queue/{guildId}/move", s.requireGuild(s.handleQueueMove))
	mux.HandleFunc("POST /api/queue/{guildId}/shuffle", s.requireGuild(s.handleQueueShuffle))
	mux.HandleFunc("POST /api/queue/{guildId}/clear", s.requireGuild(s.handleQueueClear))
	mux.HandleFunc("POST /api/player/{guildId}/pause", s.requireGuild(s.handlePlayerPause))
	mux.HandleFunc("POST /api/player/{guildId}/skip", s.requireGuild(s.handlePlayerSkip))
	mux.HandleFunc("POST /api/player/{guildId}/previous", s.requireGuild(s.handlePlayerPrevious))
	mux.HandleFunc("POST /api/player/{guildId}/seek", s.requireGuild(s.handlePlayerSeek))
	mux.HandleFunc("POST /api/player/{guildId}/stop", s.requireGuild(s.handlePlayerStop))
	mux.HandleFunc("GET /api/player/{guildId}/status", s.requireGuild(s.handlePlayerStatus))

	// Realtime (plain WebSocket; replaces Socket.io)
	mux.HandleFunc("GET /api/ws", s.handleWS)

	// Leaderboards
	mux.HandleFunc("GET /api/leaderboard/{guildId}", s.requireGuild(s.handleLeaderboard))
	mux.HandleFunc("GET /api/leaderboard/{guildId}/user/{odUserId}", s.requireGuild(s.handleLeaderboardUser))

	// Listening history
	mux.HandleFunc("GET /api/history/{guildId}", s.requireGuild(s.handleHistory))
	mux.HandleFunc("GET /api/history/{guildId}/stats", s.requireGuild(s.handleHistoryStats))

	// Profiles
	mux.HandleFunc("GET /api/profile/{userId}", s.requireAuth(s.handleProfile))
	mux.HandleFunc("GET /api/profile/{userId}/compatibility/{otherUserId}", s.requireAuth(s.handleCompatibility))

	// Wrapped
	mux.HandleFunc("GET /api/wrapped/{guildId}/server", s.requireGuild(s.handleWrappedServer))
	mux.HandleFunc("GET /api/wrapped/{guildId}/compare/{userId1}/{userId2}", s.requireGuild(s.handleWrappedCompare))
	mux.HandleFunc("GET /api/wrapped/{guildId}/{userId}", s.requireGuild(s.handleWrappedUser))

	// User data
	mux.HandleFunc("GET /api/user/playlists", s.requireAuth(s.handlePlaylistsList))
	mux.HandleFunc("POST /api/user/playlists", s.requireAuth(s.handlePlaylistsCreate))
	mux.HandleFunc("DELETE /api/user/playlists/{id}", s.requireAuth(s.handlePlaylistsDelete))
	mux.HandleFunc("GET /api/user/preferences", s.requireAuth(s.handlePreferencesGet))
	mux.HandleFunc("PUT /api/user/preferences", s.requireAuth(s.handlePreferencesPut))

	// YouTube watch-list
	mux.HandleFunc("GET /api/youtube/{guildId}", s.requireGuild(s.handleYouTubeList))
	mux.HandleFunc("POST /api/youtube/{guildId}", s.requireGuild(s.handleYouTubeAdd))
	mux.HandleFunc("DELETE /api/youtube/{guildId}/{handle}", s.requireGuild(s.handleYouTubeRemove))

	// Settings
	mux.HandleFunc("GET /api/settings/{guildId}", s.requireGuild(s.handleSettingsGet))
	mux.HandleFunc("PUT /api/settings/{guildId}", s.requireGuild(s.handleSettingsPut))

	// 404 fallback for anything else under /api/
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "Not found")
	})

	return mux
}
