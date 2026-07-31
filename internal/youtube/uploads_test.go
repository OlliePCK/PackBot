package youtube

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestRecentUploadsUsesUploadsPlaylistAndDecodesMetadata(t *testing.T) {
	var channelCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("key") != "test-key" {
			t.Errorf("missing API key: %s", r.URL.RawQuery)
		}
		switch r.URL.Path {
		case "/channels":
			channelCalls.Add(1)
			if got := r.URL.Query().Get("part"); got != "contentDetails" {
				t.Errorf("channels part = %q", got)
			}
			fmt.Fprint(w, `{"items":[{"id":"UC123","contentDetails":{"relatedPlaylists":{"uploads":"UU123"}}}]}`)
		case "/playlistItems":
			if got := r.URL.Query().Get("playlistId"); got != "UU123" {
				t.Errorf("playlist ID = %q", got)
			}
			if got := r.URL.Query().Get("maxResults"); got != "50" {
				t.Errorf("maxResults = %q", got)
			}
			fmt.Fprint(w, `{"items":[{"snippet":{"title":"Hide &amp; Seek &#39;Test&#39;","channelTitle":"Noskii &amp; Co","publishedAt":"2026-08-01T09:00:00Z","resourceId":{"videoId":"fallback"},"thumbnails":{"high":{"url":"https://img/high.jpg"}}},"contentDetails":{"videoId":"video-1","videoPublishedAt":"2026-08-01T10:30:00Z"}}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := &Client{apiKey: "test-key", http: server.Client(), baseURL: server.URL}
	videos, err := client.RecentUploads(context.Background(), "UC123", 99)
	if err != nil {
		t.Fatalf("RecentUploads: %v", err)
	}
	if len(videos) != 1 {
		t.Fatalf("videos = %d, want 1", len(videos))
	}
	video := videos[0]
	if video.ID != "video-1" {
		t.Errorf("video ID = %q", video.ID)
	}
	if video.Title != "Hide & Seek 'Test'" {
		t.Errorf("decoded title = %q", video.Title)
	}
	if video.ChannelTitle != "Noskii & Co" {
		t.Errorf("decoded channel = %q", video.ChannelTitle)
	}
	wantPublished := time.Date(2026, 8, 1, 10, 30, 0, 0, time.UTC)
	if !video.PublishedAt.Equal(wantPublished) {
		t.Errorf("published = %v, want %v", video.PublishedAt, wantPublished)
	}

	if _, err := client.RecentUploads(context.Background(), "UC123", 50); err != nil {
		t.Fatalf("second RecentUploads: %v", err)
	}
	if got := channelCalls.Load(); got != 1 {
		t.Errorf("uploads playlist lookup calls = %d, want cached value", got)
	}
}
