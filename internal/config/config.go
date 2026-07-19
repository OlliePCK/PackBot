// Package config loads all runtime configuration from environment variables
// (12-factor). Variable names match the Node bot's contract in ENVIRONMENT.md
// so the Unraid deployment carries over unchanged.
package config

import (
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the full runtime configuration for the bot process.
// Fields are added per port batch; only what the code actually reads lives here.
type Config struct {
	// Discord
	Token    string // TOKEN (required)
	ClientID string // CLIENT_ID (required)

	// Command registration (replaces Node's manual deploy-commands.js step).
	// RegisterCommands performs a bulk overwrite of application commands on
	// startup. DevGuildID scopes that overwrite to one guild (instant
	// propagation, safe for testing); empty means global.
	RegisterCommands bool   // REGISTER_COMMANDS (default false)
	DevGuildID       string // DEV_GUILD_ID (optional)

	MySQL MySQL
	Log   Log

	// YouTubeAPIKey enables the YouTube Data API (notifications job and the
	// /youtube command). Empty disables those features gracefully.
	YouTubeAPIKey string // YOUTUBE_API_KEY (optional)

	// ProxyURL, when set, proxies YouTube notification polling (parity with
	// the Node job's PROXY_URL usage).
	ProxyURL string // PROXY_URL (optional)

	// YTMaxBackoffMultiplier caps the notifications polling backoff
	// (base 30min × multiplier; default 8 → 4h).
	YTMaxBackoffMultiplier int // YT_MAX_BACKOFF_MULTIPLIER (default 8)

	API API

	// Lavalink node connection (music playback). Empty address disables music.
	LavalinkAddress  string // LAVALINK_ADDRESS (e.g. "localhost:2333")
	LavalinkPassword string // LAVALINK_PASSWORD

	// Spotify app credentials for track/album/playlist resolution (optional).
	SpotifyClientID     string // SPOTIFY_CLIENT_ID
	SpotifyClientSecret string // SPOTIFY_CLIENT_SECRET

	// AFLAPIURL points at the AFL prediction model's dashboard (e.g.
	// "http://192.168.1.16:3002"). Empty disables /tips and AFL announcements.
	AFLAPIURL string // AFL_API_URL (optional)

	Media Media
}

// Media configures the main-guild-only Jellyfin Live TV integration. Invalid
// media settings disable only this feature rather than taking the whole bot
// down; ValidationError is logged without exposing the API key.
type Media struct {
	Enabled         bool   // MEDIA_ENABLED (default false)
	GuildID         string // MEDIA_GUILD_ID
	ValidationError error

	JellyfinURL       string // JELLYFIN_URL (internal base URL)
	JellyfinPublicURL string // JELLYFIN_PUBLIC_URL (public HTTPS base URL)
	JellyfinAPIKey    string // JELLYFIN_API_KEY

	// Map keys are stable Jellyfin IDs; values are safe public names.
	ViewerAliases map[string]string // MEDIA_USER_ALIASES_JSON
	Channels      map[string]string // MEDIA_CHANNELS_JSON

	// AFLChannelIDs is an ordered, preferred subset of Channels.
	AFLChannelIDs []string // MEDIA_AFL_CHANNEL_IDS

	PollInterval  time.Duration // MEDIA_POLL_INTERVAL (default 15s)
	AnnounceDelay time.Duration // MEDIA_ANNOUNCE_DELAY (default 15s)
	StopGrace     time.Duration // MEDIA_STOP_GRACE (default 30s)
}

// API configures the web API server (Express + Socket.io in Node).
type API struct {
	Enabled bool   // ENABLE_API (default true; "false" disables)
	Port    string // API_PORT (default 3001, matching the deployed containers)

	CORSOrigin          string // CORS_ORIGIN (default "*")
	DiscordClientSecret string // DISCORD_CLIENT_SECRET (required for OAuth login)
	OAuthRedirectURI    string // OAUTH_REDIRECT_URI
	FrontendURL         string // FRONTEND_URL (post-login redirect target)

	// SecureCookies mirrors Node's NODE_ENV=production cookie behaviour.
	SecureCookies bool // NODE_ENV == "production"

	// AdminUserID is the super-admin Discord user who sees all guilds
	// (was hardcoded in Node; promoted to env per the port decisions).
	// Also the bot-owner identity: receives operational DMs (YouTube OAuth
	// failure alerts) and gates the owner-only /ytauth command.
	AdminUserID string // API_ADMIN_USER_ID (optional)
}

// MySQL is the database connection configuration (all required).
type MySQL struct {
	Host     string // MYSQL_HOST
	Port     string // MYSQL_PORT
	User     string // MYSQL_USER
	Password string // MYSQL_PASSWORD
	DB       string // MYSQL_DB
}

// Log configures slog output.
type Log struct {
	Level  slog.Level // LOG_LEVEL: debug|info|warn|error (default info)
	Format string     // LOG_FORMAT: text|json (default text)
}

// Load reads configuration from the process environment.
func Load() (*Config, error) {
	cfg := &Config{
		Token:            strings.TrimSpace(os.Getenv("TOKEN")),
		ClientID:         strings.TrimSpace(os.Getenv("CLIENT_ID")),
		RegisterCommands: boolEnv("REGISTER_COMMANDS", false),
		DevGuildID:       strings.TrimSpace(os.Getenv("DEV_GUILD_ID")),
	}

	if cfg.Token == "" {
		return nil, fmt.Errorf("config: TOKEN is required")
	}
	if cfg.ClientID == "" {
		return nil, fmt.Errorf("config: CLIENT_ID is required")
	}

	cfg.MySQL = MySQL{
		Host:     strings.TrimSpace(os.Getenv("MYSQL_HOST")),
		Port:     strings.TrimSpace(os.Getenv("MYSQL_PORT")),
		User:     strings.TrimSpace(os.Getenv("MYSQL_USER")),
		Password: os.Getenv("MYSQL_PASSWORD"),
		DB:       strings.TrimSpace(os.Getenv("MYSQL_DB")),
	}
	for name, value := range map[string]string{
		"MYSQL_HOST": cfg.MySQL.Host, "MYSQL_PORT": cfg.MySQL.Port,
		"MYSQL_USER": cfg.MySQL.User, "MYSQL_PASSWORD": cfg.MySQL.Password,
		"MYSQL_DB": cfg.MySQL.DB,
	} {
		if value == "" {
			return nil, fmt.Errorf("config: %s is required", name)
		}
	}

	cfg.YouTubeAPIKey = strings.TrimSpace(os.Getenv("YOUTUBE_API_KEY"))
	cfg.ProxyURL = strings.TrimSpace(os.Getenv("PROXY_URL"))
	cfg.YTMaxBackoffMultiplier = intEnv("YT_MAX_BACKOFF_MULTIPLIER", 8)

	port := strings.TrimSpace(os.Getenv("API_PORT"))
	if port == "" {
		port = "3001"
	}
	cfg.API = API{
		Enabled:             boolEnv("ENABLE_API", true),
		Port:                port,
		CORSOrigin:          strings.TrimSpace(os.Getenv("CORS_ORIGIN")),
		DiscordClientSecret: strings.TrimSpace(os.Getenv("DISCORD_CLIENT_SECRET")),
		OAuthRedirectURI:    strings.TrimSpace(os.Getenv("OAUTH_REDIRECT_URI")),
		FrontendURL:         strings.TrimSpace(os.Getenv("FRONTEND_URL")),
		SecureCookies:       strings.EqualFold(strings.TrimSpace(os.Getenv("NODE_ENV")), "production"),
		AdminUserID:         strings.TrimSpace(os.Getenv("API_ADMIN_USER_ID")),
	}
	if cfg.API.CORSOrigin == "" {
		cfg.API.CORSOrigin = "*"
	}

	cfg.LavalinkAddress = strings.TrimSpace(os.Getenv("LAVALINK_ADDRESS"))
	cfg.LavalinkPassword = os.Getenv("LAVALINK_PASSWORD")
	cfg.SpotifyClientID = strings.TrimSpace(os.Getenv("SPOTIFY_CLIENT_ID"))
	cfg.SpotifyClientSecret = strings.TrimSpace(os.Getenv("SPOTIFY_CLIENT_SECRET"))
	cfg.AFLAPIURL = strings.TrimRight(strings.TrimSpace(os.Getenv("AFL_API_URL")), "/")

	cfg.Media = loadMedia()
	level, err := parseLogLevel(os.Getenv("LOG_LEVEL"))
	if err != nil {
		return nil, err
	}
	format, err := parseLogFormat(os.Getenv("LOG_FORMAT"))
	if err != nil {
		return nil, err
	}
	cfg.Log = Log{Level: level, Format: format}

	return cfg, nil
}

func parseLogLevel(raw string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "info":
		return slog.LevelInfo, nil
	case "debug":
		return slog.LevelDebug, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("config: invalid LOG_LEVEL %q (want debug|info|warn|error)", raw)
	}
}

func parseLogFormat(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "text":
		return "text", nil
	case "json":
		return "json", nil
	default:
		return "", fmt.Errorf("config: invalid LOG_FORMAT %q (want text|json)", raw)
	}
}

// intEnv reads an env var as an int, falling back to def when unset/invalid.
func intEnv(name string, def int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

// boolEnv reads an env var as a boolean, mirroring the Node bot's loose
// convention where "1" and "true" are truthy and "0"/"false" are falsy.
func boolEnv(name string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true":
		return true
	case "0", "false":
		return false
	default:
		return def
	}
}
