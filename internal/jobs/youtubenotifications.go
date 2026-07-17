package jobs

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
	"github.com/OlliePCK/packbot/internal/youtube"
)

const (
	ytBaseInterval  = 30 * time.Minute
	ytConcurrency   = 5
	ytMaxMissCount  = 10
	ytFetchTimeout  = 20 * time.Second
	ytNotifyTimeout = 15 * time.Second
)

// ytBackoffState tracks per-channel polling backoff: after a cycle with no
// new video the channel skips 2^missCount − 1 cycles (capped by the
// configured multiplier) — parity with the Node job.
type ytBackoffState struct {
	missCount      int
	skipsRemaining int
}

// nextSkips returns how many upcoming cycles to skip for a given miss count.
func nextSkips(missCount, maxMultiplier int) int {
	mult := 1
	for range missCount {
		mult *= 2
		if mult >= maxMultiplier {
			mult = maxMultiplier
			break
		}
	}
	return mult - 1
}

// YouTubeNotifications polls watched channels every 30 minutes and announces
// new uploads to each guild's configured channel.
func YouTubeNotifications(ctx context.Context, s *discordgo.Session, store *storage.Store, yt *youtube.Client, maxBackoffMultiplier int) {
	log := slog.With("job", "youtube")
	log.Info("youtube notifications started",
		"interval", ytBaseInterval, "maxBackoff", time.Duration(maxBackoffMultiplier)*ytBaseInterval)

	backoff := make(map[string]*ytBackoffState) // channelId → state
	// notified deduplicates across guilds sharing a notify channel:
	// "notifyChannel:videoId" → seen.
	notified := make(map[string]bool)

	ticker := time.NewTicker(ytBaseInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Info("youtube notifications stopped")
			return
		case <-ticker.C:
			checkAll(ctx, s, store, yt, log, backoff, notified, maxBackoffMultiplier)
		}
	}
}

func checkAll(ctx context.Context, s *discordgo.Session, store *storage.Store, yt *youtube.Client,
	log *slog.Logger, backoff map[string]*ytBackoffState, notified map[string]bool, maxMult int) {

	log.Info("youtube check cycle start")
	watchList, err := store.WatchList(ctx)
	if err != nil {
		log.Error("failed to load watch list", "error", err)
		return
	}

	// Group rows by YouTube channel so shared channels are fetched once.
	grouped := make(map[string][]storage.WatchedChannel)
	for _, w := range watchList {
		grouped[w.ChannelID] = append(grouped[w.ChannelID], w)
	}

	// Bounded concurrency via a semaphore channel — the stdlib idiom that
	// replaces Node's p-limit.
	sem := make(chan struct{}, ytConcurrency)
	var wg sync.WaitGroup
	var mu sync.Mutex // guards backoff + notified across goroutines

	for channelID, group := range grouped {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			processChannel(ctx, s, store, yt, log, channelID, group, backoff, notified, maxMult, &mu)
		}()
	}
	wg.Wait()
	log.Info("youtube check cycle end")
}

func processChannel(ctx context.Context, s *discordgo.Session, store *storage.Store, yt *youtube.Client,
	log *slog.Logger, channelID string, group []storage.WatchedChannel,
	backoff map[string]*ytBackoffState, notified map[string]bool, maxMult int, mu *sync.Mutex) {

	mu.Lock()
	state, ok := backoff[channelID]
	if !ok {
		state = &ytBackoffState{}
		backoff[channelID] = state
	}
	if state.skipsRemaining > 0 {
		state.skipsRemaining--
		mu.Unlock()
		return
	}
	mu.Unlock()

	fetchCtx, cancel := context.WithTimeout(ctx, ytFetchTimeout)
	latest, err := yt.LatestVideo(fetchCtx, channelID)
	cancel()

	miss := func() {
		mu.Lock()
		state.missCount = min(state.missCount+1, ytMaxMissCount)
		state.skipsRemaining = nextSkips(state.missCount, maxMult)
		mu.Unlock()
	}

	if err != nil {
		log.Error("fetch latest video failed", "channel", channelID, "error", err)
		miss()
		return
	}
	if latest == nil {
		miss()
		return
	}

	anyNew := false
	for _, row := range group {
		// First sighting: seed without notifying.
		if !row.Initialized || row.LastCheckedVideo == nil {
			if err := store.MarkVideoSeen(ctx, row.Handle, channelID, row.GuildID, latest.ID); err != nil {
				log.Error("failed to seed video state", "handle", row.Handle, "error", err)
			}
			continue
		}
		if *row.LastCheckedVideo == latest.ID {
			continue // nothing new
		}

		dedupeKey := row.NotifyChannelID + ":" + latest.ID
		mu.Lock()
		alreadySent := notified[dedupeKey]
		notified[dedupeKey] = true
		mu.Unlock()

		if !alreadySent {
			if err := sendVideoNotification(s, row.NotifyChannelID, latest); err != nil {
				log.Error("notify failed", "guild", row.GuildID, "channel", channelID, "error", err)
			}
		}
		if err := store.MarkVideoSeen(ctx, row.Handle, channelID, row.GuildID, latest.ID); err != nil {
			log.Error("failed to update video state", "handle", row.Handle, "error", err)
		}
		anyNew = true
	}

	mu.Lock()
	if anyNew {
		state.missCount = 0
		state.skipsRemaining = 0
	} else {
		state.missCount = min(state.missCount+1, ytMaxMissCount)
		state.skipsRemaining = nextSkips(state.missCount, maxMult)
	}
	mu.Unlock()
}

func sendVideoNotification(s *discordgo.Session, notifyChannelID string, video *youtube.Video) error {
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
	_, err := s.ChannelMessageSendComplex(notifyChannelID, &discordgo.MessageSend{
		Content: "🔔 New video: " + youtube.WatchURL(video.ID),
		Embeds:  []*discordgo.MessageEmbed{embed},
	})
	return err
}
