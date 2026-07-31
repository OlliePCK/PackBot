package jobs

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/youtube"
)

type fakeYouTubeStore struct {
	watch     []storage.WatchedChannel
	states    map[string]string
	skipped   map[string]string
	completed []string
	released  []string
	marked    []string
}

func newFakeYouTubeStore(watch []storage.WatchedChannel) *fakeYouTubeStore {
	return &fakeYouTubeStore{watch: watch, states: make(map[string]string), skipped: make(map[string]string)}
}

func (f *fakeYouTubeStore) WatchList(context.Context) ([]storage.WatchedChannel, error) {
	return f.watch, nil
}
func (f *fakeYouTubeStore) MarkVideoSeen(_ context.Context, _, _, _, videoID string) error {
	f.marked = append(f.marked, videoID)
	return nil
}
func (f *fakeYouTubeStore) ClaimYouTubeNotification(_ context.Context, key storage.YouTubeNotificationKey, _ time.Time) (storage.YouTubeNotificationClaim, bool, error) {
	id := fakeYouTubeKey(key)
	if f.states[id] != "" || f.skipped[id] != "" {
		return storage.YouTubeNotificationClaim{}, false, nil
	}
	f.states[id] = "claimed"
	return storage.YouTubeNotificationClaim{Key: key, Token: "0123456789abcdef0123456789abcdef"}, true, nil
}
func (f *fakeYouTubeStore) CompleteYouTubeNotification(_ context.Context, claim storage.YouTubeNotificationClaim, _ string) error {
	id := fakeYouTubeKey(claim.Key)
	f.states[id] = "sent"
	f.completed = append(f.completed, claim.Key.VideoID)
	return nil
}
func (f *fakeYouTubeStore) ReleaseYouTubeNotification(_ context.Context, claim storage.YouTubeNotificationClaim, _ error) error {
	id := fakeYouTubeKey(claim.Key)
	delete(f.states, id)
	f.released = append(f.released, claim.Key.VideoID)
	return nil
}
func (f *fakeYouTubeStore) SkipYouTubeNotification(_ context.Context, key storage.YouTubeNotificationKey, _ time.Time, reason string) error {
	f.skipped[fakeYouTubeKey(key)] = reason
	return nil
}

func fakeYouTubeKey(key storage.YouTubeNotificationKey) string {
	return key.NotifyChannelID + ":" + key.YouTubeChannelID + ":" + key.VideoID
}

type fakeUploadSource struct {
	videos []youtube.Video
}

func (f fakeUploadSource) RecentUploads(_ context.Context, _ string, limit int) ([]youtube.Video, error) {
	if limit != ytCandidateLimit {
		return nil, errors.New("unexpected candidate limit")
	}
	return append([]youtube.Video(nil), f.videos...), nil
}

func testYouTubeLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestClassifyYouTubeCandidate(t *testing.T) {
	now := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	row := storage.WatchedChannel{CreatedAt: now.Add(-2 * time.Hour)}
	tests := []struct {
		name  string
		video youtube.Video
		want  youtubeCandidateDisposition
	}{
		{"fresh", youtube.Video{PublishedAt: now.Add(-time.Hour)}, youtubeCandidateDeliver},
		{"before subscription", youtube.Video{PublishedAt: now.Add(-3 * time.Hour)}, youtubeCandidateSkip},
		{"expired", youtube.Video{PublishedAt: now.Add(-48 * time.Hour)}, youtubeCandidateSkip},
		{"future", youtube.Video{PublishedAt: now.Add(time.Hour)}, youtubeCandidateWait},
		{"missing date", youtube.Video{}, youtubeCandidateSkip},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _ := classifyYouTubeCandidate(row, tt.video, now)
			if got != tt.want {
				t.Fatalf("disposition = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestYouTubeCheckOrdersAndDurablyDeduplicates(t *testing.T) {
	now := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	row := storage.WatchedChannel{
		Handle: "Noskii", ChannelID: "yt-channel", GuildID: "guild",
		NotifyChannelID: "discord-channel", CreatedAt: now.Add(-2 * time.Hour),
	}
	store := newFakeYouTubeStore([]storage.WatchedChannel{row})
	source := fakeUploadSource{videos: []youtube.Video{
		{ID: "newer", PublishedAt: now.Add(-10 * time.Minute)},
		{ID: "ancient", PublishedAt: time.Date(2021, 8, 17, 4, 0, 17, 0, time.UTC)},
		{ID: "older", PublishedAt: now.Add(-20 * time.Minute)},
		{ID: "older", PublishedAt: now.Add(-20 * time.Minute)},
		{ID: "future", PublishedAt: now.Add(time.Hour)},
	}}
	var sent []string
	notify := func(_ string, video *youtube.Video) (string, error) {
		sent = append(sent, video.ID)
		return "message-" + video.ID, nil
	}

	runYouTubeCheck(context.Background(), store, source, notify, now, testYouTubeLog())
	if len(sent) != 2 || sent[0] != "older" || sent[1] != "newer" {
		t.Fatalf("notification order = %v, want [older newer]", sent)
	}
	ancientKey := fakeYouTubeKey(youtubeNotificationKey(row, "ancient"))
	if store.skipped[ancientKey] == "" {
		t.Fatal("historical upload was not durably skipped")
	}

	// Simulate another cycle or a process restart using the same durable store.
	sent = nil
	runYouTubeCheck(context.Background(), store, source, notify, now.Add(30*time.Minute), testYouTubeLog())
	if len(sent) != 0 {
		t.Fatalf("durably completed videos were sent again: %v", sent)
	}
}

func TestYouTubeCheckReleasesFailureAndPreservesOrder(t *testing.T) {
	now := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	row := storage.WatchedChannel{
		Handle: "Noskii", ChannelID: "yt-channel", GuildID: "guild",
		NotifyChannelID: "discord-channel", CreatedAt: now.Add(-time.Hour),
	}
	store := newFakeYouTubeStore([]storage.WatchedChannel{row})
	source := fakeUploadSource{videos: []youtube.Video{
		{ID: "second", PublishedAt: now.Add(-10 * time.Minute)},
		{ID: "first", PublishedAt: now.Add(-20 * time.Minute)},
	}}
	var attempted []string
	failedNotify := func(_ string, video *youtube.Video) (string, error) {
		attempted = append(attempted, video.ID)
		return "", errors.New("discord unavailable")
	}
	runYouTubeCheck(context.Background(), store, source, failedNotify, now, testYouTubeLog())
	if len(attempted) != 1 || attempted[0] != "first" {
		t.Fatalf("failure attempts = %v, want only [first]", attempted)
	}
	if len(store.released) != 1 || store.released[0] != "first" {
		t.Fatalf("released = %v, want [first]", store.released)
	}

	attempted = nil
	successNotify := func(_ string, video *youtube.Video) (string, error) {
		attempted = append(attempted, video.ID)
		return "message-" + video.ID, nil
	}
	runYouTubeCheck(context.Background(), store, source, successNotify, now.Add(30*time.Minute), testYouTubeLog())
	if len(attempted) != 2 || attempted[0] != "first" || attempted[1] != "second" {
		t.Fatalf("retry order = %v, want [first second]", attempted)
	}
}
