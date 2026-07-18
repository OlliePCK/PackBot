package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Pinned to v10: the unversioned API returns guild `permissions` as a JSON
// number, v10 as a string. parsePermissions tolerates both regardless.
const discordAPI = "https://discord.com/api/v10"

// redirectURI returns the configured OAuth redirect, falling back to deriving
// it from the request like the Node code did.
func (s *Server) redirectURI(r *http.Request) string {
	if s.cfg.OAuthRedirectURI != "" {
		return s.cfg.OAuthRedirectURI
	}
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s/api/auth/callback", scheme, r.Host)
}

func (s *Server) frontendRedirect(w http.ResponseWriter, r *http.Request, path string) {
	base := s.cfg.FrontendURL
	if base == "" {
		base = ""
	}
	http.Redirect(w, r, base+path, http.StatusFound)
}

// handleAuthRedirect starts the OAuth flow. A CSRF state token is stored on
// the session (an improvement over Node, which had no state parameter).
func (s *Server) handleAuthRedirect(w http.ResponseWriter, r *http.Request) {
	sess := s.ensureSession(w, r)
	sess.oauthState = randomHex(oauthStateSize)

	params := url.Values{
		"client_id":     {s.discord.State.User.ID},
		"redirect_uri":  {s.redirectURI(r)},
		"response_type": {"code"},
		"scope":         {"identify guilds"},
		"state":         {sess.oauthState},
	}
	http.Redirect(w, r, discordAPI+"/oauth2/authorize?"+params.Encode(), http.StatusFound)
}

func (s *Server) handleAuthCallback(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	if code == "" {
		s.frontendRedirect(w, r, "/?error=no_code")
		return
	}

	sess := s.sessionFrom(r)
	if sess == nil || sess.oauthState == "" || sess.oauthState != r.URL.Query().Get("state") {
		s.frontendRedirect(w, r, "/?error=bad_state")
		return
	}
	sess.oauthState = ""

	// Exchange the code for tokens.
	form := url.Values{
		"client_id":     {s.discord.State.User.ID},
		"client_secret": {s.cfg.DiscordClientSecret},
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {s.redirectURI(r)},
	}
	res, err := http.PostForm(discordAPI+"/oauth2/token", form)
	if err != nil {
		s.log.Error("oauth token exchange failed", "error", err)
		s.frontendRedirect(w, r, "/?error=token_error")
		return
	}
	defer res.Body.Close()

	var tokens struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		Error        string `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&tokens); err != nil || tokens.Error != "" || tokens.AccessToken == "" {
		s.log.Error("oauth token error", "error", tokens.Error)
		s.frontendRedirect(w, r, "/?error=token_error")
		return
	}

	user, guilds, err := s.fetchDiscordUser(tokens.AccessToken)
	if err != nil {
		s.log.Error("oauth user fetch failed", "error", err)
		s.frontendRedirect(w, r, "/?error=auth_failed")
		return
	}

	user.AccessToken = tokens.AccessToken
	user.RefreshToken = tokens.RefreshToken
	user.Guilds = guilds
	sess.user = user
	s.sessions.persist(sess)

	s.log.Info("user authenticated via OAuth", "userId", user.ID, "username", user.Username)
	s.frontendRedirect(w, r, "/dashboard")
}

// fetchDiscordUser loads /users/@me and the user's guilds, filtered to
// guilds the bot shares, with the admin bit computed per guild.
func (s *Server) fetchDiscordUser(accessToken string) (*SessionUser, []SessionGuild, error) {
	get := func(path string, out any) error {
		req, err := http.NewRequest(http.MethodGet, discordAPI+path, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+accessToken)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return fmt.Errorf("discord API %s returned HTTP %d", path, res.StatusCode)
		}
		return json.NewDecoder(res.Body).Decode(out)
	}

	var me struct {
		ID            string `json:"id"`
		Username      string `json:"username"`
		Discriminator string `json:"discriminator"`
		Avatar        string `json:"avatar"`
	}
	if err := get("/users/@me", &me); err != nil {
		return nil, nil, err
	}

	var rawGuilds []struct {
		ID          string          `json:"id"`
		Name        string          `json:"name"`
		Icon        string          `json:"icon"`
		Permissions json.RawMessage `json:"permissions"`
	}
	if err := get("/users/@me/guilds", &rawGuilds); err != nil {
		return nil, nil, err
	}

	// Keep only guilds the bot is in.
	botGuilds := make(map[string]bool)
	for _, g := range s.discord.State.Guilds {
		botGuilds[g.ID] = true
	}

	var guilds []SessionGuild
	for _, g := range rawGuilds {
		if !botGuilds[g.ID] {
			continue
		}
		guilds = append(guilds, SessionGuild{
			ID:      g.ID,
			Name:    g.Name,
			Icon:    g.Icon,
			IsAdmin: parsePermissions(g.Permissions)&0x8 == 0x8, // ADMINISTRATOR
		})
	}

	return &SessionUser{
		ID:            me.ID,
		Username:      me.Username,
		Discriminator: me.Discriminator,
		Avatar:        me.Avatar,
	}, guilds, nil
}

func (s *Server) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	sess := s.sessionFrom(r)
	if sess == nil || sess.user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"authenticated": false})
		return
	}
	user := sess.user

	var avatar *string
	if user.Avatar != "" {
		url := fmt.Sprintf("https://cdn.discordapp.com/avatars/%s/%s.png", user.ID, user.Avatar)
		avatar = &url
	}
	guilds := user.Guilds
	if guilds == nil {
		guilds = []SessionGuild{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"id":            user.ID,
		"username":      user.Username,
		"avatar":        avatar,
		"guilds":        guilds,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookie); err == nil {
		s.sessions.destroy(cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// parsePermissions reads a Discord permissions bitfield that may arrive as a
// JSON string ("2147483647") or a bare number depending on API version.
func parsePermissions(raw json.RawMessage) uint64 {
	s := strings.Trim(string(raw), `"`)
	perms, _ := strconv.ParseUint(s, 10, 64)
	return perms
}

// guildIconURL builds the CDN icon URL Node returned on /guilds.
func guildIconURL(guildID, icon string) *string {
	if icon == "" {
		return nil
	}
	url := fmt.Sprintf("https://cdn.discordapp.com/icons/%s/%s.webp?size=64", guildID, icon)
	return &url
}

// trimHandle strips a leading @ (shared by the YouTube endpoints).
func trimHandle(handle string) string {
	return strings.TrimPrefix(strings.TrimSpace(handle), "@")
}
