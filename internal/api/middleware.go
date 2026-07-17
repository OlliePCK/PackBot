package api

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// authedHandler is a handler that requires an authenticated session user.
type authedHandler func(w http.ResponseWriter, r *http.Request, user *SessionUser)

// requireAuth wraps a handler with the session check (Node's requireAuth).
func (s *Server) requireAuth(next authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess := s.sessionFrom(r)
		if sess == nil || sess.user == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]any{
				"error":         "Authentication required",
				"authenticated": false,
			})
			return
		}
		next(w, r, sess.user)
	}
}

// requireGuild wraps requireAuth and additionally checks access to the
// {guildId} path segment.
func (s *Server) requireGuild(next authedHandler) http.HandlerFunc {
	return s.requireAuth(func(w http.ResponseWriter, r *http.Request, user *SessionUser) {
		if !s.hasGuildAccess(user, r.PathValue("guildId")) {
			writeError(w, http.StatusForbidden, "No access to this guild")
			return
		}
		next(w, r, user)
	})
}

// isSuperAdmin reports whether the user is the configured API admin.
func (s *Server) isSuperAdmin(user *SessionUser) bool {
	return s.cfg.AdminUserID != "" && user.ID == s.cfg.AdminUserID
}

// hasGuildAccess mirrors Node's helper: super-admin sees everything, others
// need the guild in their session's mutual-guild list.
func (s *Server) hasGuildAccess(user *SessionUser, guildID string) bool {
	if guildID == "" {
		return false
	}
	if s.isSuperAdmin(user) {
		return true
	}
	for _, g := range user.Guilds {
		if g.ID == guildID {
			return true
		}
	}
	return false
}

// userGuildIDs returns the guilds the user's data queries may span.
func (s *Server) userGuildIDs(user *SessionUser) []string {
	if s.isSuperAdmin(user) {
		guilds := s.discord.State.Guilds
		ids := make([]string, len(guilds))
		for i, g := range guilds {
			ids[i] = g.ID
		}
		return ids
	}
	ids := make([]string, len(user.Guilds))
	for i, g := range user.Guilds {
		ids[i] = g.ID
	}
	return ids
}

// statusRecorder captures the response status for request logging.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (rec *statusRecorder) WriteHeader(code int) {
	rec.status = code
	rec.ResponseWriter.WriteHeader(code)
}

// logMiddleware logs every request with its response status (debug level).
func (s *Server) logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// WebSocket upgrades need the raw ResponseWriter (http.Hijacker).
		if r.Header.Get("Upgrade") == "websocket" {
			next.ServeHTTP(w, r)
			return
		}
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		s.log.Debug("request", "method", r.Method, "path", r.URL.Path, "status", rec.status)
	})
}

// corsMiddleware applies the configured CORS policy (Node: cors middleware
// with credentials enabled).
func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := s.cfg.CORSOrigin
		if origin == "*" {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		} else {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// queryInt parses an integer query parameter with default and maximum.
func queryInt(r *http.Request, name string, def, max int) int {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return def
	}
	if max > 0 && n > max {
		return max
	}
	return n
}
