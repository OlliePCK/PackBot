package media

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

type resolverProgramsSource struct {
	programs   []LiveTVProgram
	channelIDs []string
	minEndDate time.Time
	maxStart   time.Time
}

func (s *resolverProgramsSource) LiveTVPrograms(
	_ context.Context,
	channelIDs []string,
	minEndDate time.Time,
	maxStartDate time.Time,
) ([]LiveTVProgram, error) {
	s.channelIDs = append([]string(nil), channelIDs...)
	s.minEndDate = minEndDate
	s.maxStart = maxStartDate
	return append([]LiveTVProgram(nil), s.programs...), nil
}

func TestAFLBroadcastResolverRequiresBothNonOverlappingTeams(t *testing.T) {
	kickoff := time.Date(2026, time.July, 19, 9, 20, 0, 0, time.UTC)
	tests := []struct {
		name        string
		home        string
		away        string
		programName string
		wantMatch   bool
	}{
		{
			name:        "GWS and Sydney both present",
			home:        "Greater Western Sydney",
			away:        "Sydney",
			programName: "AFL: GWS Giants v Sydney Swans",
			wantMatch:   true,
		},
		{
			name:        "Sydney only appears inside Greater Western Sydney",
			home:        "Greater Western Sydney",
			away:        "Sydney",
			programName: "AFL: Greater Western Sydney Giants v Carlton Blues",
			wantMatch:   false,
		},
		{
			name:        "Port Adelaide and Adelaide both present",
			home:        "Port Adelaide",
			away:        "Adelaide",
			programName: "AFL: Port Adelaide Power v Adelaide Crows",
			wantMatch:   true,
		},
		{
			name:        "Adelaide only appears inside Port Adelaide",
			home:        "Port Adelaide",
			away:        "Adelaide",
			programName: "AFL: Port Adelaide Power v Carlton Blues",
			wantMatch:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			source := &resolverProgramsSource{programs: []LiveTVProgram{{
				ID:          "program-1",
				Name:        tt.programName,
				ChannelID:   "channel-503",
				ChannelName: "Fox Sports 503",
				Start:       kickoff.Add(-5 * time.Minute),
				End:         kickoff.Add(3 * time.Hour),
			}}}
			resolver := newTestAFLResolver(t, source, "channel-503")

			got, err := resolver.Resolve(context.Background(), AFLMatchQuery{
				Home: tt.home, Away: tt.away, Kickoff: kickoff,
			}, nil)
			if err != nil {
				t.Fatalf("Resolve: %v", err)
			}
			if (got != nil) != tt.wantMatch {
				t.Fatalf("Resolve result = %#v, wantMatch = %v", got, tt.wantMatch)
			}
		})
	}
}

func TestAFLBroadcastResolverExcludesAFLWSpellings(t *testing.T) {
	kickoff := time.Date(2026, time.July, 19, 9, 20, 0, 0, time.UTC)
	for _, title := range []string{
		"AFLW: Sydney Swans v Adelaide Crows",
		"AFL W: Sydney Swans v Adelaide Crows",
		"AFL Women's: Sydney Swans v Adelaide Crows",
	} {
		t.Run(title, func(t *testing.T) {
			source := &resolverProgramsSource{programs: []LiveTVProgram{{
				ID:          "program-1",
				Name:        title,
				ChannelID:   "channel-503",
				ChannelName: "Fox Sports 503",
				Start:       kickoff,
				End:         kickoff.Add(2 * time.Hour),
			}}}
			resolver := newTestAFLResolver(t, source, "channel-503")

			got, err := resolver.Resolve(context.Background(), AFLMatchQuery{
				Home: "Sydney", Away: "Adelaide", Kickoff: kickoff,
			}, nil)
			if err != nil {
				t.Fatalf("Resolve: %v", err)
			}
			if got != nil {
				t.Fatalf("Resolve result = %#v, want nil for AFLW guide entry", got)
			}
		})
	}
}

func TestProgramInAFLWindow(t *testing.T) {
	kickoff := time.Date(2026, time.July, 19, 9, 20, 0, 0, time.UTC)
	tests := []struct {
		name  string
		start time.Time
		end   time.Time
		want  bool
	}{
		{
			name:  "normal overlap",
			start: kickoff.Add(-10 * time.Minute),
			end:   kickoff.Add(3 * time.Hour),
			want:  true,
		},
		{
			name:  "earliest accepted boundary",
			start: kickoff.Add(-aflProgramLookback),
			end:   kickoff.Add(time.Hour),
			want:  true,
		},
		{
			name:  "starts too early",
			start: kickoff.Add(-aflProgramLookback - time.Nanosecond),
			end:   kickoff.Add(time.Hour),
			want:  false,
		},
		{
			name:  "latest accepted start",
			start: kickoff.Add(aflProgramStartGrace),
			end:   kickoff.Add(2 * time.Hour),
			want:  true,
		},
		{
			name:  "starts too late",
			start: kickoff.Add(aflProgramStartGrace + time.Nanosecond),
			end:   kickoff.Add(2 * time.Hour),
			want:  false,
		},
		{
			name:  "earliest accepted end",
			start: kickoff.Add(-time.Hour),
			end:   kickoff.Add(-aflProgramEndGrace),
			want:  true,
		},
		{
			name:  "ends too early",
			start: kickoff.Add(-time.Hour),
			end:   kickoff.Add(-aflProgramEndGrace - time.Nanosecond),
			want:  false,
		},
		{
			name:  "invalid interval",
			start: kickoff,
			end:   kickoff,
			want:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := programInAFLWindow(kickoff, LiveTVProgram{Start: tt.start, End: tt.end})
			if got != tt.want {
				t.Fatalf("programInAFLWindow = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestAFLBroadcastResolverUsesOrderedAllowlist(t *testing.T) {
	kickoff := time.Date(2026, time.July, 19, 9, 20, 0, 0, time.UTC)
	source := &resolverProgramsSource{programs: []LiveTVProgram{
		{
			ID: "program-fallback", Name: "AFL Sydney v Adelaide",
			ChannelID: "channel-fallback", ChannelName: "Fallback",
			Start: kickoff, End: kickoff.Add(3 * time.Hour),
		},
		{
			ID: "program-ignored", Name: "AFL Sydney v Adelaide",
			ChannelID: "channel-not-allowed", ChannelName: "Not allowed",
			Start: kickoff, End: kickoff.Add(3 * time.Hour),
		},
		{
			ID: "program-preferred", Name: "AFL Sydney v Adelaide",
			ChannelID: "channel-preferred", ChannelName: "Preferred",
			Start: kickoff.Add(20 * time.Minute), End: kickoff.Add(3 * time.Hour),
		},
	}}
	resolver := newTestAFLResolver(t, source, "channel-preferred", "channel-fallback")

	got, err := resolver.Resolve(context.Background(), AFLMatchQuery{
		Home: "Sydney", Away: "Adelaide", Kickoff: kickoff,
	}, nil)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got == nil || got.ChannelID != "channel-preferred" {
		t.Fatalf("Resolve result = %#v, want preferred allowlisted channel", got)
	}
	if strings.Join(source.channelIDs, ",") != "channel-preferred,channel-fallback" {
		t.Fatalf("source channel IDs = %v, want configured order", source.channelIDs)
	}
	if !source.minEndDate.Equal(kickoff.Add(-aflProgramEndGrace)) {
		t.Fatalf("source minEndDate = %s", source.minEndDate)
	}
	if !source.maxStart.Equal(kickoff.Add(aflProgramStartGrace)) {
		t.Fatalf("source maxStartDate = %s", source.maxStart)
	}
}

func TestAFLBroadcastResolverActiveChannelStates(t *testing.T) {
	kickoff := time.Date(2026, time.July, 19, 9, 20, 0, 0, time.UTC)
	programs := []LiveTVProgram{
		{
			ID: "program-preferred", Name: "AFL Sydney v Adelaide",
			ChannelID: "channel-preferred", ChannelName: "Preferred",
			Start: kickoff, End: kickoff.Add(3 * time.Hour),
		},
		{
			ID: "program-fallback", Name: "AFL Sydney v Adelaide",
			ChannelID: "channel-fallback", ChannelName: "Fallback",
			Start: kickoff, End: kickoff.Add(3 * time.Hour),
		},
	}
	tests := []struct {
		name       string
		sessions   []LiveTVSession
		wantID     string
		wantState  AFLBroadcastState
		wantResult bool
	}{
		{
			name:       "idle offers Watch on preferred",
			wantID:     "channel-preferred",
			wantState:  AFLBroadcastWatch,
			wantResult: true,
		},
		{
			name: "exact active candidate offers Join",
			sessions: []LiveTVSession{{
				ChannelID: "channel-fallback",
			}},
			wantID:     "channel-fallback",
			wantState:  AFLBroadcastJoin,
			wantResult: true,
		},
		{
			name: "different active channel has no button",
			sessions: []LiveTVSession{{
				ChannelID: "channel-other",
			}},
		},
		{
			name: "multiple active channels are ambiguous",
			sessions: []LiveTVSession{
				{ChannelID: "channel-fallback"},
				{ChannelID: "channel-other"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			source := &resolverProgramsSource{programs: programs}
			resolver := newTestAFLResolver(
				t, source, "channel-preferred", "channel-fallback",
			)
			got, err := resolver.Resolve(context.Background(), AFLMatchQuery{
				Home: "Sydney", Away: "Adelaide", Kickoff: kickoff,
			}, tt.sessions)
			if err != nil {
				t.Fatalf("Resolve: %v", err)
			}
			if !tt.wantResult {
				if got != nil {
					t.Fatalf("Resolve result = %#v, want nil", got)
				}
				return
			}
			if got == nil || got.ChannelID != tt.wantID || got.State != tt.wantState {
				t.Fatalf(
					"Resolve result = %#v, want channel %q and state %q",
					got, tt.wantID, tt.wantState,
				)
			}
		})
	}
}

func TestAFLBroadcastResolverBuildsHTTPSDetailsURLWithoutToken(t *testing.T) {
	kickoff := time.Date(2026, time.July, 19, 9, 20, 0, 0, time.UTC)
	source := &resolverProgramsSource{programs: []LiveTVProgram{{
		ID: "program-1", Name: "AFL Sydney v Adelaide",
		ChannelID: "channel-503", ChannelName: "Fox Sports 503",
		Start: kickoff, End: kickoff.Add(3 * time.Hour),
	}}}
	resolver, err := NewAFLBroadcastResolver(
		source,
		"https://jellyfin.example/base/",
		[]string{"channel-503"},
	)
	if err != nil {
		t.Fatalf("NewAFLBroadcastResolver: %v", err)
	}

	got, err := resolver.Resolve(context.Background(), AFLMatchQuery{
		Home: "Sydney", Away: "Adelaide", Kickoff: kickoff,
	}, nil)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got == nil {
		t.Fatal("Resolve result is nil")
	}
	parsed, err := url.Parse(got.WatchURL)
	if err != nil {
		t.Fatalf("parse watch URL: %v", err)
	}
	if parsed.Scheme != "https" || parsed.Host != "jellyfin.example" {
		t.Fatalf("watch URL = %q, want HTTPS jellyfin.example", got.WatchURL)
	}
	if parsed.Path != "/base/web/" || parsed.Fragment != "/details?id=channel-503" {
		t.Fatalf("watch URL = %q, want token-free web details route", got.WatchURL)
	}
	if parsed.User != nil || parsed.RawQuery != "" {
		t.Fatalf("watch URL contains credentials or query: %q", got.WatchURL)
	}
	lower := strings.ToLower(got.WatchURL)
	for _, marker := range []string{"api_key", "apikey", "access_token", "token"} {
		if strings.Contains(lower, marker) {
			t.Fatalf("watch URL contains credential marker %q: %q", marker, got.WatchURL)
		}
	}
}

func newTestAFLResolver(
	t *testing.T,
	source LiveTVProgramsSource,
	channelIDs ...string,
) *AFLBroadcastResolver {
	t.Helper()
	resolver, err := NewAFLBroadcastResolver(
		source,
		"https://jellyfin.example",
		channelIDs,
	)
	if err != nil {
		t.Fatalf("NewAFLBroadcastResolver: %v", err)
	}
	return resolver
}
