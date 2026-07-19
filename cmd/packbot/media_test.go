package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/OlliePCK/packbot/internal/afl"
	"github.com/OlliePCK/packbot/internal/media"
)

type fakeLiveTVSessionSource struct {
	sessions []media.LiveTVSession
	err      error
	calls    int
}

func (f *fakeLiveTVSessionSource) LiveTVSessions(context.Context) ([]media.LiveTVSession, error) {
	f.calls++
	return f.sessions, f.err
}

type fakeAFLBroadcastSource struct {
	broadcast *media.AFLBroadcast
	err       error
	calls     int
	query     media.AFLMatchQuery
	sessions  []media.LiveTVSession
}

func (f *fakeAFLBroadcastSource) Resolve(
	_ context.Context,
	query media.AFLMatchQuery,
	sessions []media.LiveTVSession,
) (*media.AFLBroadcast, error) {
	f.calls++
	f.query = query
	f.sessions = append([]media.LiveTVSession(nil), sessions...)
	return f.broadcast, f.err
}

func TestMediaBroadcastAdapterRejectsOtherGuildBeforeUpstreamCalls(t *testing.T) {
	sessions := &fakeLiveTVSessionSource{}
	resolver := &fakeAFLBroadcastSource{}
	adapter := &mediaBroadcastAdapter{
		mainGuildID: "main-guild",
		sessions:    sessions,
		resolver:    resolver,
	}

	got, err := adapter.ResolveAFL(context.Background(), " other-guild ", afl.Match{})
	if err != nil {
		t.Fatalf("ResolveAFL() error = %v", err)
	}
	if got != nil {
		t.Fatalf("ResolveAFL() = %#v, want nil", got)
	}
	if sessions.calls != 0 {
		t.Fatalf("LiveTVSessions() calls = %d, want 0", sessions.calls)
	}
	if resolver.calls != 0 {
		t.Fatalf("Resolve() calls = %d, want 0", resolver.calls)
	}
}

func TestMediaBroadcastAdapterConvertsMainGuildMatchAndLabelsLink(t *testing.T) {
	kickoff := time.Date(2026, time.July, 19, 15, 20, 0, 0, time.FixedZone("AEST", 10*60*60))
	liveSessions := []media.LiveTVSession{{
		ViewerID:    "viewer",
		ChannelID:   "channel",
		ChannelName: "Fox Sports 503",
	}}

	tests := []struct {
		name      string
		state     media.AFLBroadcastState
		wantLabel string
	}{
		{name: "join active channel", state: media.AFLBroadcastJoin, wantLabel: "Join on Jellyfin"},
		{name: "watch idle channel", state: media.AFLBroadcastWatch, wantLabel: "Watch on Jellyfin"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sessions := &fakeLiveTVSessionSource{sessions: liveSessions}
			resolver := &fakeAFLBroadcastSource{broadcast: &media.AFLBroadcast{
				ChannelID:   "channel",
				ChannelName: "Fox Sports 503",
				WatchURL:    "https://jellyfin.example/web/#/details?id=channel",
				State:       tt.state,
			}}
			adapter := &mediaBroadcastAdapter{
				mainGuildID: "main-guild",
				sessions:    sessions,
				resolver:    resolver,
			}
			match := afl.Match{
				GameID:  "game-1",
				Home:    "Sydney",
				Away:    "Collingwood",
				Kickoff: kickoff,
				Round:   "Round 19",
			}

			got, err := adapter.ResolveAFL(context.Background(), " main-guild ", match)
			if err != nil {
				t.Fatalf("ResolveAFL() error = %v", err)
			}
			if got == nil {
				t.Fatal("ResolveAFL() = nil, want link")
			}
			if got.URL != resolver.broadcast.WatchURL {
				t.Errorf("link URL = %q, want %q", got.URL, resolver.broadcast.WatchURL)
			}
			if got.Label != tt.wantLabel {
				t.Errorf("link label = %q, want %q", got.Label, tt.wantLabel)
			}
			if got.ChannelName != resolver.broadcast.ChannelName {
				t.Errorf("channel name = %q, want %q", got.ChannelName, resolver.broadcast.ChannelName)
			}
			if sessions.calls != 1 || resolver.calls != 1 {
				t.Fatalf("upstream calls = sessions %d, resolver %d; want 1 each", sessions.calls, resolver.calls)
			}
			if resolver.query.Home != match.Home ||
				resolver.query.Away != match.Away ||
				!resolver.query.Kickoff.Equal(match.Kickoff) {
				t.Errorf("resolver query = %#v, want teams and kickoff from %#v", resolver.query, match)
			}
			if len(resolver.sessions) != 1 || resolver.sessions[0] != liveSessions[0] {
				t.Errorf("resolver sessions = %#v, want %#v", resolver.sessions, liveSessions)
			}
		})
	}
}

func TestMediaBroadcastAdapterErrorsAndNilResult(t *testing.T) {
	sessionErr := errors.New("sessions unavailable")
	resolverErr := errors.New("guide unavailable")

	tests := []struct {
		name              string
		sessionErr        error
		resolverErr       error
		broadcast         *media.AFLBroadcast
		wantErr           error
		wantErrSubstring  string
		wantResolverCalls int
	}{
		{
			name:              "session error",
			sessionErr:        sessionErr,
			wantErr:           sessionErr,
			wantResolverCalls: 0,
		},
		{
			name:              "resolver error",
			resolverErr:       resolverErr,
			wantErr:           resolverErr,
			wantResolverCalls: 1,
		},
		{
			name:              "no matching broadcast",
			wantResolverCalls: 1,
		},
		{
			name: "unsupported state",
			broadcast: &media.AFLBroadcast{
				WatchURL: "https://jellyfin.example/",
				State:    media.AFLBroadcastState("unexpected"),
			},
			wantErrSubstring:  "unsupported AFL broadcast state",
			wantResolverCalls: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sessions := &fakeLiveTVSessionSource{err: tt.sessionErr}
			resolver := &fakeAFLBroadcastSource{
				broadcast: tt.broadcast,
				err:       tt.resolverErr,
			}
			adapter := &mediaBroadcastAdapter{
				mainGuildID: "main-guild",
				sessions:    sessions,
				resolver:    resolver,
			}

			got, err := adapter.ResolveAFL(context.Background(), "main-guild", afl.Match{
				Home:    "Sydney",
				Away:    "Collingwood",
				Kickoff: time.Now(),
			})
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("ResolveAFL() error = %v, want %v", err, tt.wantErr)
				}
			} else if tt.wantErrSubstring != "" {
				if err == nil || !contains(err.Error(), tt.wantErrSubstring) {
					t.Fatalf("ResolveAFL() error = %v, want substring %q", err, tt.wantErrSubstring)
				}
			} else if err != nil {
				t.Fatalf("ResolveAFL() error = %v", err)
			}
			if got != nil {
				t.Fatalf("ResolveAFL() = %#v, want nil", got)
			}
			if resolver.calls != tt.wantResolverCalls {
				t.Errorf("Resolve() calls = %d, want %d", resolver.calls, tt.wantResolverCalls)
			}
		})
	}
}

func TestConfirmationPollsBoundaryMath(t *testing.T) {
	poll := 10 * time.Second
	tests := []struct {
		name  string
		delay time.Duration
		want  int
	}{
		{name: "zero delay", delay: 0, want: 2},
		{name: "less than one interval", delay: poll - time.Nanosecond, want: 2},
		{name: "exactly one interval", delay: poll, want: 2},
		{name: "just over one interval", delay: poll + time.Nanosecond, want: 3},
		{name: "exactly two intervals", delay: 2 * poll, want: 3},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := confirmationPolls(tt.delay, poll); got != tt.want {
				t.Fatalf("confirmationPolls(%v, %v) = %d, want %d", tt.delay, poll, got, tt.want)
			}
		})
	}
}

func TestMissingPollsBoundaryMath(t *testing.T) {
	poll := 10 * time.Second
	tests := []struct {
		name  string
		grace time.Duration
		want  int
	}{
		{name: "zero grace still requires one missing poll", grace: 0, want: 1},
		{name: "less than one interval", grace: poll - time.Nanosecond, want: 1},
		{name: "exactly one interval", grace: poll, want: 1},
		{name: "just over one interval", grace: poll + time.Nanosecond, want: 2},
		{name: "exactly two intervals", grace: 2 * poll, want: 2},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := missingPolls(tt.grace, poll); got != tt.want {
				t.Fatalf("missingPolls(%v, %v) = %d, want %d", tt.grace, poll, got, tt.want)
			}
		})
	}
}

func contains(value, substring string) bool {
	for i := 0; i+len(substring) <= len(value); i++ {
		if value[i:i+len(substring)] == substring {
			return true
		}
	}
	return false
}
