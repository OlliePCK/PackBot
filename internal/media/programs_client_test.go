package media

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestJellyfinProgramsClientAuthQueryAndFiltering(t *testing.T) {
	const token = "programs-test-api-key"
	minEndDate := time.Date(2026, time.July, 18, 23, 10, 0, 123, time.FixedZone("AEST", 10*60*60))
	maxStartDate := time.Date(2026, time.July, 19, 0, 50, 0, 456, time.FixedZone("AEST", 10*60*60))

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/jellyfin/LiveTv/Programs" {
			t.Errorf("path = %q, want /jellyfin/LiveTv/Programs", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != `MediaBrowser Token="`+token+`"` {
			t.Errorf("authorization = %q", got)
		}
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Errorf("accept = %q, want application/json", got)
		}
		wantQuery := url.Values{
			"channelIds":             {"channel-503,channel-504"},
			"minEndDate":             {minEndDate.UTC().Format(time.RFC3339Nano)},
			"maxStartDate":           {maxStartDate.UTC().Format(time.RFC3339Nano)},
			"enableImages":           {"false"},
			"enableTotalRecordCount": {"false"},
			"fields":                 {"Overview,Genres,Tags"},
		}
		if !reflect.DeepEqual(r.URL.Query(), wantQuery) {
			t.Errorf("query = %#v, want %#v", r.URL.Query(), wantQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
  "Items": [
    {
      "Id": "PROGRAM-1",
      "Name": " Sydney v Adelaide ",
      "SeriesName": " AFL ",
      "Overview": " Live coverage ",
      "ChannelId": "CHANNEL-503",
      "ChannelName": " Fox Sports 503 ",
      "StartDate": "2026-07-18T23:15:00Z",
      "EndDate": "2026-07-19T02:30:00Z",
      "Genres": [" Sport ", "", "Football"],
      "Tags": [" Live "],
      "IsSports": true
    },
    {
      "Id": "program-outside-allowlist",
      "Name": "Sydney v Adelaide",
      "ChannelId": "channel-505",
      "ChannelName": "Fox Sports 505",
      "StartDate": "2026-07-18T23:15:00Z",
      "EndDate": "2026-07-19T02:30:00Z"
    },
    {
      "Id": "program-bad-date",
      "Name": "Sydney v Adelaide",
      "ChannelId": "channel-504",
      "ChannelName": "Fox Sports 504",
      "StartDate": "not-a-date",
      "EndDate": "2026-07-19T02:30:00Z"
    },
    {
      "Id": "program-reversed",
      "Name": "Sydney v Adelaide",
      "ChannelId": "channel-504",
      "ChannelName": "Fox Sports 504",
      "StartDate": "2026-07-19T03:30:00Z",
      "EndDate": "2026-07-19T02:30:00Z"
    }
  ]
}`))
	}))
	defer server.Close()

	client, err := newJellyfinProgramsClient(
		server.URL+"/jellyfin/",
		token,
		server.Client(),
	)
	if err != nil {
		t.Fatalf("newJellyfinProgramsClient: %v", err)
	}
	got, err := client.LiveTVPrograms(
		context.Background(),
		[]string{"CHANNEL-503", "channel-504", "channel-503"},
		minEndDate,
		maxStartDate,
	)
	if err != nil {
		t.Fatalf("LiveTVPrograms: %v", err)
	}
	want := []LiveTVProgram{{
		ID:          "program-1",
		Name:        "Sydney v Adelaide",
		SeriesName:  "AFL",
		Overview:    "Live coverage",
		ChannelID:   "channel-503",
		ChannelName: "Fox Sports 503",
		Start:       time.Date(2026, time.July, 18, 23, 15, 0, 0, time.UTC),
		End:         time.Date(2026, time.July, 19, 2, 30, 0, 0, time.UTC),
		Genres:      []string{"Sport", "Football"},
		Tags:        []string{"Live"},
		IsSports:    true,
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("programs = %#v, want %#v", got, want)
	}
}

func TestJellyfinProgramsClientRejectsInvalidJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"Items":[`))
	}))
	defer server.Close()

	client, err := newJellyfinProgramsClient(server.URL, "test-key", server.Client())
	if err != nil {
		t.Fatalf("newJellyfinProgramsClient: %v", err)
	}
	_, err = client.LiveTVPrograms(
		context.Background(),
		[]string{"channel-503"},
		time.Now().Add(-time.Hour),
		time.Now().Add(time.Hour),
	)
	if err == nil || !strings.Contains(err.Error(), "decode Jellyfin programs") {
		t.Fatalf("LiveTVPrograms error = %v, want JSON decode error", err)
	}
}

func TestJellyfinProgramsClientRejectsOversizedResponse(t *testing.T) {
	oversized := append(
		[]byte(`{"Items":[]}`),
		bytes.Repeat([]byte(" "), maxProgramsResponseBytes)...,
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(oversized)
	}))
	defer server.Close()

	client, err := newJellyfinProgramsClient(server.URL, "test-key", server.Client())
	if err != nil {
		t.Fatalf("newJellyfinProgramsClient: %v", err)
	}
	_, err = client.LiveTVPrograms(
		context.Background(),
		[]string{"channel-503"},
		time.Now().Add(-time.Hour),
		time.Now().Add(time.Hour),
	)
	if err == nil {
		t.Fatalf(
			"LiveTVPrograms accepted a %d-byte response; limit is %d bytes",
			len(oversized),
			maxProgramsResponseBytes,
		)
	}
}

func TestJellyfinProgramsClientErrorsDoNotExposeToken(t *testing.T) {
	const token = "do-not-leak-programs-key"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(
			w,
			fmt.Sprintf("provider echoed token=%s", token),
			http.StatusUnauthorized,
		)
	}))
	defer server.Close()

	client, err := newJellyfinProgramsClient(server.URL, token, server.Client())
	if err != nil {
		t.Fatalf("newJellyfinProgramsClient: %v", err)
	}
	_, err = client.LiveTVPrograms(
		context.Background(),
		[]string{"channel-503"},
		time.Now().Add(-time.Hour),
		time.Now().Add(time.Hour),
	)
	if err == nil {
		t.Fatal("expected status error")
	}
	if strings.Contains(err.Error(), token) {
		t.Fatalf("error leaked token: %v", err)
	}
}
