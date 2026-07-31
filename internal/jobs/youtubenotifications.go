package jobs

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
	"github.com/OlliePCK/packbot/internal/youtube"
)

const (
	ytBaseInterval       = 30 * time.Minute
	ytConcurrency        = 5
	ytFetchTimeout       = 20 * time.Second
	ytCandidateLimit     = 50
	ytMaxNotificationAge = 24 * time.Hour
	ytFutureGrace        = 5 * time.Minute
)

type youtubeNotificationStore interface {
	WatchList(context.Context) ([]storage.WatchedChannel, error)
	MarkVideoSeen(context.Context, string, string, string, string) error
	ClaimYouTubeNotification(context.Context, storage.YouTubeNotificationKey, time.Time) (storage.YouTubeNotificationClaim, bool, error)
	CompleteYouTubeNotification(context.Context, storage.YouTubeNotificationClaim, string) error
	ReleaseYouTubeNotification(context.Context, storage.YouTubeNotificationClaim, error) error
	SkipYouTubeNotification(context.Context, storage.YouTubeNotificationKey, time.Time, string) error
}

type youtubeUploadSource interface {
	RecentUploads(context.Context, string, int) ([]youtube.Video, error)
}

type youtubeNotifyFunc func(string, *youtube.Video) (string, error)

type youtubeFetchResult struct {
	channelID string
	rows      []storage.WatchedChannel
	videos    []youtube.Video
	err       error
}

type youtubeDeliveryCandidate struct {
	row   storage.WatchedChannel
	video youtube.Video
}

type youtubeCandidateDisposition uint8

const (
	youtubeCandidateDeliver youtubeCandidateDisposition = iota
	youtubeCandidateSkip
	youtubeCandidateWait
)

// YouTubeNotifications checks immediately at startup and then every 30
// minutes. Every target/video delivery is claimed durably before Discord is
// called, so restarts cannot reset duplicate suppression.
func YouTubeNotifications(ctx context.Context, s *discordgo.Session, store *storage.Store, yt *youtube.Client) {
	log := slog.With("job", "youtube")
	log.Info("youtube notifications started", "interval", ytBaseInterval)

	notify := func(channelID string, video *youtube.Video) (string, error) {
		return sendVideoNotification(s, channelID, video)
	}
	runYouTubeCheck(ctx, store, yt, notify, time.Now(), log)

	ticker := time.NewTicker(ytBaseInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Info("youtube notifications stopped")
			return
		case now := <-ticker.C:
			runYouTubeCheck(ctx, store, yt, notify, now, log)
		}
	}
}

func runYouTubeCheck(ctx context.Context, store youtubeNotificationStore, yt youtubeUploadSource,
	notify youtubeNotifyFunc, now time.Time, log *slog.Logger) {
	log.Info("youtube check cycle start")
	watchList, err := store.WatchList(ctx)
	if err != nil {
		log.Error("failed to load watch list", "error", err)
		return
	}

	grouped := make(map[string][]storage.WatchedChannel)
	for _, row := range watchList {
		grouped[row.ChannelID] = append(grouped[row.ChannelID], row)
	}
	results := fetchYouTubeChannels(ctx, yt, grouped)

	var deliveries []youtubeDeliveryCandidate
	type stateUpdate struct {
		row     storage.WatchedChannel
		videoID string
	}
	var updates []stateUpdate

	for _, result := range results {
		if result.err != nil {
			log.Error("fetch recent uploads failed", "channel", result.channelID, "error", result.err)
			continue
		}
		if len(result.videos) == 0 {
			continue
		}
		videos := uniqueVideos(result.videos)
		if len(videos) == 0 {
			continue
		}
		sort.SliceStable(videos, func(i, j int) bool {
			return videos[i].PublishedAt.Before(videos[j].PublishedAt)
		})
		newestID := videos[len(videos)-1].ID

		for _, row := range result.rows {
			for i := range videos {
				video := videos[i]
				disposition, reason := classifyYouTubeCandidate(row, video, now)
				switch disposition {
				case youtubeCandidateDeliver:
					deliveries = append(deliveries, youtubeDeliveryCandidate{row: row, video: video})
				case youtubeCandidateSkip:
					key := youtubeNotificationKey(row, video.ID)
					publishedAt := video.PublishedAt
					if publishedAt.IsZero() {
						publishedAt = now
					}
					if err := store.SkipYouTubeNotification(ctx, key, publishedAt, reason); err != nil {
						log.Error("failed to persist skipped youtube video", "video", video.ID, "guild", row.GuildID, "error", err)
					}
				case youtubeCandidateWait:
					// Leave future publications unclaimed for a later cycle.
				}
			}
			updates = append(updates, stateUpdate{row: row, videoID: newestID})
		}
	}

	// Fetching remains concurrent, but delivery is deterministic across every
	// channel: oldest publication first, then stable IDs as tie-breakers.
	sort.SliceStable(deliveries, func(i, j int) bool {
		left, right := deliveries[i], deliveries[j]
		if !left.video.PublishedAt.Equal(right.video.PublishedAt) {
			return left.video.PublishedAt.Before(right.video.PublishedAt)
		}
		if left.row.NotifyChannelID != right.row.NotifyChannelID {
			return left.row.NotifyChannelID < right.row.NotifyChannelID
		}
		if left.row.ChannelID != right.row.ChannelID {
			return left.row.ChannelID < right.row.ChannelID
		}
		return left.video.ID < right.video.ID
	})

	blocked := make(map[string]bool)
	for i := range deliveries {
		candidate := &deliveries[i]
		streamKey := candidate.row.NotifyChannelID + ":" + candidate.row.ChannelID
		if blocked[streamKey] {
			continue
		}

		key := youtubeNotificationKey(candidate.row, candidate.video.ID)
		claim, claimed, err := store.ClaimYouTubeNotification(ctx, key, candidate.video.PublishedAt)
		if err != nil {
			log.Error("failed to claim youtube notification", "video", candidate.video.ID, "guild", candidate.row.GuildID, "error", err)
			blocked[streamKey] = true
			continue
		}
		if !claimed {
			continue
		}

		messageID, err := notify(candidate.row.NotifyChannelID, &candidate.video)
		if err != nil {
			log.Error("youtube notify failed", "video", candidate.video.ID, "guild", candidate.row.GuildID, "error", err)
			if releaseErr := store.ReleaseYouTubeNotification(ctx, claim, err); releaseErr != nil {
				log.Error("failed to release youtube notification claim", "video", candidate.video.ID, "error", releaseErr)
			}
			blocked[streamKey] = true
			continue
		}
		if err := store.CompleteYouTubeNotification(ctx, claim, messageID); err != nil {
			// Keep the claim leased after Discord accepted the message instead
			// of making a transient database error immediately retryable.
			log.Error("failed to complete youtube notification", "video", candidate.video.ID, "message", messageID, "error", err)
			blocked[streamKey] = true
		}
	}

	for _, update := range updates {
		if err := store.MarkVideoSeen(ctx, update.row.Handle, update.row.ChannelID, update.row.GuildID, update.videoID); err != nil {
			log.Error("failed to update youtube scan state", "handle", update.row.Handle, "error", err)
		}
	}
	log.Info("youtube check cycle end", "channels", len(grouped), "candidates", len(deliveries))
}

func fetchYouTubeChannels(ctx context.Context, yt youtubeUploadSource,
	grouped map[string][]storage.WatchedChannel) []youtubeFetchResult {
	results := make(chan youtubeFetchResult, len(grouped))
	sem := make(chan struct{}, ytConcurrency)
	var wg sync.WaitGroup
	for channelID, rows := range grouped {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			fetchCtx, cancel := context.WithTimeout(ctx, ytFetchTimeout)
			videos, err := yt.RecentUploads(fetchCtx, channelID, ytCandidateLimit)
			cancel()
			results <- youtubeFetchResult{channelID: channelID, rows: rows, videos: videos, err: err}
		}()
	}
	wg.Wait()
	close(results)

	out := make([]youtubeFetchResult, 0, len(grouped))
	for result := range results {
		out = append(out, result)
	}
	return out
}

func uniqueVideos(videos []youtube.Video) []youtube.Video {
	seen := make(map[string]bool, len(videos))
	out := make([]youtube.Video, 0, len(videos))
	for _, video := range videos {
		if video.ID == "" || seen[video.ID] {
			continue
		}
		seen[video.ID] = true
		out = append(out, video)
	}
	return out
}

func classifyYouTubeCandidate(row storage.WatchedChannel, video youtube.Video,
	now time.Time) (youtubeCandidateDisposition, string) {
	if video.PublishedAt.IsZero() {
		return youtubeCandidateSkip, "missing-published-at"
	}
	if video.PublishedAt.After(now.Add(ytFutureGrace)) {
		return youtubeCandidateWait, "future-publication"
	}
	if !row.CreatedAt.IsZero() && video.PublishedAt.Before(row.CreatedAt.Add(-ytFutureGrace)) {
		return youtubeCandidateSkip, "before-subscription"
	}
	if video.PublishedAt.Before(now.Add(-ytMaxNotificationAge)) {
		return youtubeCandidateSkip, "expired"
	}
	return youtubeCandidateDeliver, ""
}

func youtubeNotificationKey(row storage.WatchedChannel, videoID string) storage.YouTubeNotificationKey {
	return storage.YouTubeNotificationKey{
		GuildID:          row.GuildID,
		NotifyChannelID:  row.NotifyChannelID,
		YouTubeChannelID: row.ChannelID,
		VideoID:          videoID,
	}
}

func sendVideoNotification(s *discordgo.Session, notifyChannelID string, video *youtube.Video) (string, error) {
	embed := &discordgo.MessageEmbed{
		Title:       video.Title,
		URL:         youtube.WatchURL(video.ID),
		Description: "**" + video.ChannelTitle + "** uploaded a new video!",
		Color:       style.ColorBrand,
		Footer:      style.Footer(),
	}
	if video.ThumbnailURL != "" {
		embed.Thumbnail = &discordgo.MessageEmbedThumbnail{URL: video.ThumbnailURL}
	}
	message, err := style.Send(s, notifyChannelID, "🔔 New video: "+youtube.WatchURL(video.ID), embed)
	if err != nil {
		return "", err
	}
	if message == nil {
		return "", fmt.Errorf("youtube notification returned no Discord message")
	}
	return message.ID, nil
}
