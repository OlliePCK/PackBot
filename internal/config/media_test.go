package config

import (
	"testing"
	"time"
)

func TestLoadMediaValidAndCanonical(t *testing.T) {
	setRequiredConfig(t)
	for name, value := range map[string]string{
		"MEDIA_ENABLED":           "true",
		"MEDIA_GUILD_ID":          "773732791585865769",
		"JELLYFIN_URL":            "http://binhex-jellyfin:8096/",
		"JELLYFIN_PUBLIC_URL":     "https://jellyfin.example/",
		"JELLYFIN_API_KEY":        "secret-not-logged",
		"MEDIA_USER_ALIASES_JSON": `{"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE":"Ollie"}`,
		"MEDIA_CHANNELS_JSON":     `{"9C4337D6-A06D-71F9-2E4A-A499ED9C0620":"Fox Sports 503"}`,
		"MEDIA_AFL_CHANNEL_IDS":   "9C4337D6-A06D-71F9-2E4A-A499ED9C0620",
		"MEDIA_POLL_INTERVAL":     "15s",
		"MEDIA_ANNOUNCE_DELAY":    "15s",
		"MEDIA_STOP_GRACE":        "30s",
	} {
		t.Setenv(name, value)
	}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Media.ValidationError != nil {
		t.Fatalf("Media.ValidationError = %v", cfg.Media.ValidationError)
	}
	if cfg.Media.JellyfinURL != "http://binhex-jellyfin:8096" ||
		cfg.Media.JellyfinPublicURL != "https://jellyfin.example" {
		t.Errorf("URLs were not normalized: %#v", cfg.Media)
	}
	channelID := "9c4337d6a06d71f92e4aa499ed9c0620"
	if cfg.Media.Channels[channelID] != "Fox Sports 503" {
		t.Errorf("canonical channel map = %#v", cfg.Media.Channels)
	}
	if len(cfg.Media.AFLChannelIDs) != 1 || cfg.Media.AFLChannelIDs[0] != channelID {
		t.Errorf("canonical AFL channel order = %#v", cfg.Media.AFLChannelIDs)
	}
	if cfg.Media.PollInterval != 15*time.Second || cfg.Media.StopGrace != 30*time.Second {
		t.Errorf("durations = %v/%v", cfg.Media.PollInterval, cfg.Media.StopGrace)
	}
}

func TestInvalidMediaConfigDoesNotTakeDownBot(t *testing.T) {
	setRequiredConfig(t)
	t.Setenv("MEDIA_ENABLED", "true")
	t.Setenv("MEDIA_GUILD_ID", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load should preserve the rest of the bot: %v", err)
	}
	if !cfg.Media.Enabled || cfg.Media.ValidationError == nil {
		t.Fatalf("media state = enabled %v error %v", cfg.Media.Enabled, cfg.Media.ValidationError)
	}
}

func setRequiredConfig(t *testing.T) {
	t.Helper()
	for name, value := range map[string]string{
		"TOKEN": "token", "CLIENT_ID": "client",
		"MYSQL_HOST": "localhost", "MYSQL_PORT": "3306",
		"MYSQL_USER": "user", "MYSQL_PASSWORD": "password", "MYSQL_DB": "packbot",
	} {
		t.Setenv(name, value)
	}
	for _, name := range []string{
		"MEDIA_ENABLED", "MEDIA_GUILD_ID", "JELLYFIN_URL", "JELLYFIN_PUBLIC_URL",
		"JELLYFIN_API_KEY", "MEDIA_USER_ALIASES_JSON", "MEDIA_CHANNELS_JSON",
		"MEDIA_AFL_CHANNEL_IDS", "MEDIA_POLL_INTERVAL", "MEDIA_ANNOUNCE_DELAY",
		"MEDIA_STOP_GRACE",
	} {
		t.Setenv(name, "")
	}
}
