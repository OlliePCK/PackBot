package music

import "testing"

func TestAuthFailureRe(t *testing.T) {
	tests := []struct {
		name    string
		message string
		want    bool
	}{
		// Seen in production when the OAuth token was missing.
		{"requires login", "This video requires login.", true},
		{"sign in bot check", "Sign in to confirm you're not a bot", true},
		{"please sign in", "Please sign in", true},
		{"signin no space", "Signin required to continue", true},
		{"login required constant", "LOGIN_REQUIRED", true},
		{"case insensitive", "THIS VIDEO REQUIRES LOGIN.", true},

		// Ordinary playback failures must not page the admin.
		{"unavailable", "This video is unavailable", false},
		{"age restricted", "This video is age restricted", false},
		{"copyright", "This video is not available in your country", false},
		{"generic fault", "Something went wrong when decoding the track", false},
		{"empty", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := authFailureRe.MatchString(tt.message); got != tt.want {
				t.Errorf("authFailureRe.MatchString(%q) = %v, want %v", tt.message, got, tt.want)
			}
		})
	}
}

func TestCleanAuthReason(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			"real multi-client trace",
			"(yts.version: 1.18.1) All clients failed to load the item. Client [TVHTML5] failed: This video requires login.This video requires login. at dev.lavalink.youtube.clients.skeleton.Client.getPlayabilityStatus(Client.java:94) at dev.lavalink...",
			"This video requires login.",
		},
		{"plain reason no trace", "Sign in to confirm you're not a bot", "Sign in to confirm you're not a bot"},
		{"empty", "", "a login wall"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cleanAuthReason(tt.in); got != tt.want {
				t.Errorf("cleanAuthReason() = %q, want %q", got, tt.want)
			}
		})
	}
}
