package media

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestJellyfinClientLiveTVSessions(t *testing.T) {
	const token = "test-api-key"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/jellyfin/Sessions" {
			t.Errorf("path = %q, want /jellyfin/Sessions", r.URL.Path)
		}
		if r.URL.RawQuery != "" {
			t.Errorf("query = %q, want all sessions without an activity filter", r.URL.RawQuery)
		}
		if got := r.Header.Get("Authorization"); got != `MediaBrowser Token="`+token+`"` {
			t.Errorf("authorization = %q", got)
		}
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Errorf("accept = %q, want application/json", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
  {
    "Id": "sensitive-session-control-id",
    "UserId": "viewer-1",
    "UserName": "private-login-name",
    "RemoteEndPoint": "192.0.2.1",
    "DeviceName": "Bedroom television",
    "Client": "Private client",
    "NowPlayingItem": {
      "Id": "program-1",
      "Name": "Sydney v Adelaide",
      "Type": "Program",
      "ChannelId": "channel-503",
      "ChannelName": "Fox Sports 503",
      "IsLive": true,
      "Path": "https://provider.invalid/secret"
    }
  },
  {
    "UserId": "viewer-2",
    "NowPlayingItem": {
      "Id": "channel-seven",
      "Name": "Seven Melbourne",
      "Type": "TvChannel"
    }
  },
  {
    "UserId": "viewer-3",
    "NowPlayingItem": {
      "Id": "movie-1",
      "Name": "Not Live TV",
      "Type": "Movie",
      "IsLive": false
    }
  },
  {
    "UserId": "viewer-4",
    "NowPlayingItem": {
      "Id": "ordinary-program",
      "Name": "Ordinary programme without Live TV signals",
      "Type": "Program",
      "IsLive": false
    }
  },
  {
    "UserId": "viewer-5",
    "NowPlayingItem": {
      "Id": "program-504",
      "Name": "AFL: Sydney v Adelaide",
      "Type": "Program",
      "ChannelId": "channel-504",
      "ChannelName": "Fox Sports 504"
    }
  }
]`))
	}))
	defer server.Close()

	client, err := newJellyfinClient(server.URL+"/jellyfin/", token, server.Client())
	if err != nil {
		t.Fatalf("newJellyfinClient: %v", err)
	}
	got, err := client.LiveTVSessions(context.Background())
	if err != nil {
		t.Fatalf("LiveTVSessions: %v", err)
	}
	want := []LiveTVSession{
		{
			ViewerID:    "viewer-1",
			ChannelID:   "channel-503",
			ChannelName: "Fox Sports 503",
			ProgramID:   "program-1",
			ProgramName: "Sydney v Adelaide",
		},
		{
			ViewerID:    "viewer-2",
			ChannelID:   "channel-seven",
			ChannelName: "Seven Melbourne",
		},
		{
			ViewerID:    "viewer-5",
			ChannelID:   "channel-504",
			ChannelName: "Fox Sports 504",
			ProgramID:   "program-504",
			ProgramName: "AFL: Sydney v Adelaide",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sessions = %#v, want %#v", got, want)
	}
}

func TestJellyfinClientFailsClosedOnAmbiguousLiveTVSnapshot(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{
			name: "live item without channel identity",
			body: `[{"NowPlayingItem":{"Type":"Program","IsLive":true}}]`,
		},
		{
			name: "channel item without item ID",
			body: `[{"NowPlayingItem":{"Type":"TvChannel","Name":"Unknown"}}]`,
		},
		{
			name: "conflicting channel item IDs",
			body: `[{"NowPlayingItem":{"Id":"channel-a","ChannelId":"channel-b","Type":"TvChannel"}}]`,
		},
		{
			name: "null is not a complete snapshot",
			body: `null`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.RawQuery != "" {
					t.Errorf("query = %q, want all sessions", r.URL.RawQuery)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()

			client, err := newJellyfinClient(server.URL, "secret-token", server.Client())
			if err != nil {
				t.Fatalf("newJellyfinClient: %v", err)
			}
			sessions, err := client.LiveTVSessions(context.Background())
			if err == nil {
				t.Fatalf("LiveTVSessions = %#v, want fail-closed error", sessions)
			}
			if strings.Contains(err.Error(), "secret-token") {
				t.Fatalf("error leaked token: %v", err)
			}
		})
	}
}

func TestNewJellyfinClientValidation(t *testing.T) {
	tests := []struct {
		name    string
		baseURL string
		token   string
	}{
		{name: "missing URL", token: "key"},
		{name: "missing token", baseURL: "https://jellyfin.example"},
		{name: "relative URL", baseURL: "/jellyfin", token: "key"},
		{name: "URL credentials", baseURL: "https://user:pass@jellyfin.example", token: "key"},
		{name: "URL query", baseURL: "https://jellyfin.example?key=value", token: "key"},
		{name: "bad token", baseURL: "https://jellyfin.example", token: "bad\"token"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := newJellyfinClient(tt.baseURL, tt.token, http.DefaultClient); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestJellyfinClientErrorsDoNotExposeToken(t *testing.T) {
	const token = "do-not-leak-this-key"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `provider said token=do-not-leak-this-key`, http.StatusUnauthorized)
	}))
	defer server.Close()

	client, err := newJellyfinClient(server.URL, token, server.Client())
	if err != nil {
		t.Fatalf("newJellyfinClient: %v", err)
	}
	_, err = client.LiveTVSessions(context.Background())
	if err == nil {
		t.Fatal("expected status error")
	}
	if strings.Contains(err.Error(), token) {
		t.Fatalf("error leaked token: %v", err)
	}
}
