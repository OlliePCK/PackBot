package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/OlliePCK/packbot/internal/storage"
)

// Session lifetime and cookie name. Session IDs are 32 random bytes, so
// unlike Node's express-session no signing secret is needed — the ID itself
// is unguessable and all data lives server-side.
const (
	sessionCookie  = "packbot_session"
	sessionTTL     = 7 * 24 * time.Hour
	cleanupEvery   = 10 * time.Minute
	oauthStateSize = 16
)

// SessionGuild is a mutual guild stored on the session with the user's
// admin flag (permission bit 0x8 at login time).
type SessionGuild struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Icon    string `json:"icon"`
	IsAdmin bool   `json:"isAdmin"`
}

// SessionUser is the authenticated user attached to a session.
type SessionUser struct {
	ID            string
	Username      string
	Discriminator string
	Avatar        string
	AccessToken   string
	RefreshToken  string
	Guilds        []SessionGuild
}

type session struct {
	id         string
	user       *SessionUser // nil until OAuth completes
	oauthState string       // CSRF token for the in-flight OAuth flow
	expiresAt  time.Time
}

// sessionStore keeps sessions in memory with the authenticated ones written
// through to the Sessions table, so dashboard logins survive bot restarts
// (previously memory-only — every deploy logged everyone out). Pre-OAuth
// sessions (just a CSRF state) stay memory-only; losing one mid-login merely
// means clicking "Login" again.
type sessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*session
	store    *storage.Store // nil disables persistence (tests)
}

func newSessionStore(store *storage.Store) *sessionStore {
	return &sessionStore{sessions: make(map[string]*session), store: store}
}

func randomHex(bytes int) string {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand failed: " + err.Error()) // effectively impossible
	}
	return hex.EncodeToString(buf)
}

func (st *sessionStore) create() *session {
	sess := &session{
		id:        randomHex(32),
		expiresAt: time.Now().Add(sessionTTL),
	}
	st.mu.Lock()
	st.sessions[sess.id] = sess
	st.mu.Unlock()
	return sess
}

func (st *sessionStore) get(id string) *session {
	st.mu.RLock()
	sess, ok := st.sessions[id]
	st.mu.RUnlock()
	if ok {
		if time.Now().After(sess.expiresAt) {
			return nil
		}
		return sess
	}
	return st.rehydrate(id)
}

// rehydrate restores a persisted session after a restart (memory miss).
func (st *sessionStore) rehydrate(id string) *session {
	if st.store == nil || len(id) != 64 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	data, expiresAt, err := st.store.LoadSession(ctx, id)
	if err != nil {
		if err != storage.ErrSessionNotFound {
			slog.Error("failed to load persisted session", "error", err)
		}
		return nil
	}
	var user SessionUser
	if err := json.Unmarshal(data, &user); err != nil {
		slog.Error("corrupt persisted session, discarding", "error", err)
		_ = st.store.DeleteSession(ctx, id)
		return nil
	}
	sess := &session{id: id, user: &user, expiresAt: expiresAt}
	st.mu.Lock()
	st.sessions[id] = sess
	st.mu.Unlock()
	return sess
}

// persist writes an authenticated session through to the database. Call
// after attaching the user.
func (st *sessionStore) persist(sess *session) {
	if st.store == nil || sess.user == nil {
		return
	}
	data, err := json.Marshal(sess.user)
	if err != nil {
		slog.Error("failed to serialize session", "error", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := st.store.SaveSession(ctx, sess.id, sess.user.ID, data, sess.expiresAt); err != nil {
		slog.Error("failed to persist session", "error", err)
	}
}

func (st *sessionStore) destroy(id string) {
	st.mu.Lock()
	delete(st.sessions, id)
	st.mu.Unlock()
	if st.store != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := st.store.DeleteSession(ctx, id); err != nil {
			slog.Error("failed to delete persisted session", "error", err)
		}
	}
}

func (st *sessionStore) cleanupLoop(ctx context.Context) {
	ticker := time.NewTicker(cleanupEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			st.mu.Lock()
			for id, sess := range st.sessions {
				if now.After(sess.expiresAt) {
					delete(st.sessions, id)
				}
			}
			st.mu.Unlock()
			if st.store != nil {
				if _, err := st.store.DeleteExpiredSessions(ctx); err != nil {
					slog.Error("failed to prune expired sessions", "error", err)
				}
			}
		}
	}
}

// sessionFrom resolves the request's session cookie (nil when absent/expired).
func (s *Server) sessionFrom(r *http.Request) *session {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return nil
	}
	return s.sessions.get(cookie.Value)
}

// ensureSession returns the request's session, creating one (and setting the
// cookie) when needed.
func (s *Server) ensureSession(w http.ResponseWriter, r *http.Request) *session {
	if sess := s.sessionFrom(r); sess != nil {
		return sess
	}
	sess := s.sessions.create()
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    sess.id,
		Path:     "/",
		MaxAge:   int(sessionTTL.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   s.secureCookie(r),
	})
	return sess
}

// secureCookie mirrors Node's `secure: 'auto'` behind a trusted proxy: mark
// cookies Secure in production when the request arrived over HTTPS (directly
// or via X-Forwarded-Proto from nginx).
func (s *Server) secureCookie(r *http.Request) bool {
	if !s.cfg.SecureCookies {
		return false
	}
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}
