package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"sync"
	"time"
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

type sessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*session
}

func newSessionStore() *sessionStore {
	return &sessionStore{sessions: make(map[string]*session)}
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
	if !ok || time.Now().After(sess.expiresAt) {
		return nil
	}
	return sess
}

func (st *sessionStore) destroy(id string) {
	st.mu.Lock()
	delete(st.sessions, id)
	st.mu.Unlock()
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
