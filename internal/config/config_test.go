package config

import (
	"log/slog"
	"strings"
	"testing"
)

func TestLoad(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantErr string // substring of the expected error; empty means success
		check   func(t *testing.T, cfg *Config)
	}{
		{
			name:    "missing token",
			env:     map[string]string{"CLIENT_ID": "123"},
			wantErr: "TOKEN is required",
		},
		{
			name:    "missing client id",
			env:     map[string]string{"TOKEN": "abc"},
			wantErr: "CLIENT_ID is required",
		},
		{
			name: "defaults",
			env:  map[string]string{"TOKEN": "abc", "CLIENT_ID": "123"},
			check: func(t *testing.T, cfg *Config) {
				if cfg.Log.Level != slog.LevelInfo {
					t.Errorf("Log.Level = %v, want info", cfg.Log.Level)
				}
				if cfg.Log.Format != "text" {
					t.Errorf("Log.Format = %q, want text", cfg.Log.Format)
				}
				if cfg.RegisterCommands {
					t.Error("RegisterCommands = true, want false by default")
				}
			},
		},
		{
			name: "full valid config",
			env: map[string]string{
				"TOKEN":             "abc",
				"CLIENT_ID":         "123",
				"LOG_LEVEL":         "DEBUG",
				"LOG_FORMAT":        "json",
				"REGISTER_COMMANDS": "true",
				"DEV_GUILD_ID":      "773732791585865769",
			},
			check: func(t *testing.T, cfg *Config) {
				if cfg.Log.Level != slog.LevelDebug {
					t.Errorf("Log.Level = %v, want debug", cfg.Log.Level)
				}
				if cfg.Log.Format != "json" {
					t.Errorf("Log.Format = %q, want json", cfg.Log.Format)
				}
				if !cfg.RegisterCommands {
					t.Error("RegisterCommands = false, want true")
				}
				if cfg.DevGuildID != "773732791585865769" {
					t.Errorf("DevGuildID = %q", cfg.DevGuildID)
				}
			},
		},
		{
			name:    "missing mysql host",
			env:     map[string]string{"TOKEN": "abc", "CLIENT_ID": "123", "MYSQL_HOST": ""},
			wantErr: "MYSQL_HOST is required",
		},
		{
			name:    "invalid log level",
			env:     map[string]string{"TOKEN": "abc", "CLIENT_ID": "123", "LOG_LEVEL": "verbose"},
			wantErr: "invalid LOG_LEVEL",
		},
		{
			name:    "invalid log format",
			env:     map[string]string{"TOKEN": "abc", "CLIENT_ID": "123", "LOG_FORMAT": "xml"},
			wantErr: "invalid LOG_FORMAT",
		},
		{
			name: "whitespace trimmed",
			env:  map[string]string{"TOKEN": "  abc  ", "CLIENT_ID": " 123 "},
			check: func(t *testing.T, cfg *Config) {
				if cfg.Token != "abc" || cfg.ClientID != "123" {
					t.Errorf("Token/ClientID not trimmed: %q %q", cfg.Token, cfg.ClientID)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// t.Setenv both sets the var and restores it after the test.
			// Clear the vars Load reads so ambient shell values can't leak in.
			for _, name := range []string{"TOKEN", "CLIENT_ID", "LOG_LEVEL", "LOG_FORMAT", "REGISTER_COMMANDS", "DEV_GUILD_ID"} {
				t.Setenv(name, "")
			}
			// MySQL config is required; give every case a valid baseline so
			// the cases above stay focused on what they actually test.
			for name, value := range map[string]string{
				"MYSQL_HOST": "localhost", "MYSQL_PORT": "3306", "MYSQL_USER": "u",
				"MYSQL_PASSWORD": "p", "MYSQL_DB": "packbot",
			} {
				t.Setenv(name, value)
			}
			for name, value := range tt.env {
				t.Setenv(name, value)
			}

			cfg, err := Load()
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("Load() succeeded, want error containing %q", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("Load() error = %q, want containing %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if tt.check != nil {
				tt.check(t, cfg)
			}
		})
	}
}

func TestBoolEnv(t *testing.T) {
	tests := []struct {
		value string
		def   bool
		want  bool
	}{
		{"1", false, true},
		{"true", false, true},
		{"TRUE", false, true},
		{"0", true, false},
		{"false", true, false},
		{"", true, true},
		{"", false, false},
		{"garbage", true, true},
		{"garbage", false, false},
	}
	for _, tt := range tests {
		t.Run(tt.value, func(t *testing.T) {
			t.Setenv("PACKBOT_TEST_BOOL", tt.value)
			if got := boolEnv("PACKBOT_TEST_BOOL", tt.def); got != tt.want {
				t.Errorf("boolEnv(%q, %v) = %v, want %v", tt.value, tt.def, got, tt.want)
			}
		})
	}
}
