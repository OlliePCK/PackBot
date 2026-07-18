// Package music is PackBot's music system, built on a Lavalink v4 node via
// disgolink. Lavalink owns the voice connection (including DAVE E2EE),
// audio sourcing, decoding and filters; this package owns queues, track
// resolution and Discord-side UX.
//
// Voice wiring with discordgo: the bot never opens its own voice connection.
// It sends the gateway "join channel" op (ChannelVoiceJoinManual) and
// forwards the resulting VoiceServerUpdate/VoiceStateUpdate events to
// disgolink, which hands them to Lavalink.
package music

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/disgoorg/disgolink/v3/disgolink"
	"github.com/disgoorg/disgolink/v3/lavalink"
	"github.com/disgoorg/snowflake/v2"

	"github.com/OlliePCK/packbot/internal/spotify"
	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
	"github.com/OlliePCK/packbot/internal/youtube"
)

// Manager owns the Lavalink client and per-guild player state.
type Manager struct {
	session *discordgo.Session
	client  disgolink.Client
	store   *storage.Store
	spotify *spotify.Client // nil when SPOTIFY_* unset
	yt      *youtube.Client // nil when YOUTUBE_API_KEY unset
	log     *slog.Logger

	// Node coordinates kept for direct HTTP calls to plugin routes that
	// disgolink doesn't cover (youtube-source's /youtube — see ytauth.go).
	nodeAddress  string
	nodePassword string

	// adminUserID (API_ADMIN_USER_ID) receives operational DMs — currently
	// the YouTube OAuth login-wall alert. Empty disables alerting.
	adminUserID string

	authMu        sync.Mutex
	lastAuthAlert time.Time

	mu     sync.Mutex
	guilds map[string]*GuildPlayer

	updates listenerRegistry
}

// GuildPlayer is one guild's queue and playback state. All fields are
// guarded by mu (Lavalink events and command handlers run concurrently).
type GuildPlayer struct {
	mu sync.Mutex

	GuildID        string
	TextChannelID  string
	VoiceChannelID string

	Queue      []*Track
	History    []*Track
	Current    *Track
	RepeatMode RepeatMode
	Autoplay   bool
	Volume     int
	Filters    []string // active filter keys, in activation order

	// skipping suppresses the natural-advance logic for the TrackEnd that a
	// deliberate skip/stop/replace causes.
	stopping bool

	// onChange notifies the manager's update listeners (set at creation).
	onChange func()
}

// NewManager connects to the Lavalink node and wires event listeners.
func NewManager(ctx context.Context, session *discordgo.Session, store *storage.Store, sp *spotify.Client, yt *youtube.Client, botUserID, address, password, adminUserID string) (*Manager, error) {
	m := &Manager{
		session:      session,
		store:        store,
		spotify:      sp,
		yt:           yt,
		log:          slog.With("component", "music"),
		nodeAddress:  address,
		nodePassword: password,
		adminUserID:  adminUserID,
		guilds:       make(map[string]*GuildPlayer),
	}

	m.client = disgolink.New(snowflake.MustParse(botUserID),
		disgolink.WithListenerFunc(m.onTrackStart),
		disgolink.WithListenerFunc(m.onTrackEnd),
		disgolink.WithListenerFunc(m.onTrackException),
		disgolink.WithListenerFunc(m.onTrackStuck),
	)

	nodeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, err := m.client.AddNode(nodeCtx, disgolink.NodeConfig{
		Name:     "main",
		Address:  address,
		Password: password,
		Secure:   false,
	})
	if err != nil {
		return nil, fmt.Errorf("music: connect lavalink node %s: %w", address, err)
	}
	m.log.Info("lavalink node connected", "address", address)

	session.AddHandler(m.onVoiceServerUpdate)
	session.AddHandler(m.onVoiceStateUpdate)

	return m, nil
}

// Guild returns (creating if needed) the guild's player state.
func (m *Manager) Guild(guildID string) *GuildPlayer {
	m.mu.Lock()
	defer m.mu.Unlock()
	gp, ok := m.guilds[guildID]
	if !ok {
		gp = &GuildPlayer{GuildID: guildID, Volume: 100}
		gp.onChange = func() { m.notifyUpdate(guildID) }
		m.guilds[guildID] = gp
	}
	return gp
}

// Active reports whether the guild has a session (current track or queue).
func (m *Manager) Active(guildID string) bool {
	gp := m.Guild(guildID)
	gp.mu.Lock()
	defer gp.mu.Unlock()
	return gp.Current != nil || len(gp.Queue) > 0
}

// --- discordgo → disgolink voice glue ---

func (m *Manager) onVoiceServerUpdate(s *discordgo.Session, e *discordgo.VoiceServerUpdate) {
	m.client.OnVoiceServerUpdate(context.Background(), snowflake.MustParse(e.GuildID), e.Token, e.Endpoint)
}

func (m *Manager) onVoiceStateUpdate(s *discordgo.Session, e *discordgo.VoiceStateUpdate) {
	if s.State.User == nil {
		return
	}
	if e.UserID == s.State.User.ID {
		var channelID *snowflake.ID
		if e.ChannelID != "" {
			id := snowflake.MustParse(e.ChannelID)
			channelID = &id
		}
		m.client.OnVoiceStateUpdate(context.Background(), snowflake.MustParse(e.GuildID), channelID, e.SessionID)
		if e.ChannelID == "" {
			// Bot was disconnected (kick or /leave): full cleanup, no rejoin
			// (parity with Node's voiceStateUpdate handling).
			m.cleanup(e.GuildID)
		}
		return
	}
	m.checkAutoLeave(e)
}

// checkAutoLeave leaves the channel when the last human leaves, unless 24/7
// mode is enabled (Node: events/client/voiceStateUpdate.js).
func (m *Manager) checkAutoLeave(e *discordgo.VoiceStateUpdate) {
	gp := m.Guild(e.GuildID)
	gp.mu.Lock()
	botChannel := gp.VoiceChannelID
	textChannel := gp.TextChannelID
	gp.mu.Unlock()
	if botChannel == "" {
		return
	}
	// Only care when someone left the bot's channel.
	if e.BeforeUpdate == nil || e.BeforeUpdate.ChannelID != botChannel || e.ChannelID == botChannel {
		return
	}

	guild, err := m.session.State.Guild(e.GuildID)
	if err != nil {
		return
	}
	humans := 0
	for _, vs := range guild.VoiceStates {
		if vs.ChannelID != botChannel {
			continue
		}
		if member, err := m.session.State.Member(e.GuildID, vs.UserID); err == nil && member.User != nil && member.User.Bot {
			continue
		}
		if vs.UserID == m.session.State.User.ID {
			continue
		}
		humans++
	}
	if humans > 0 {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	profile, err := m.store.GuildProfile(ctx, e.GuildID)
	cancel()
	if err == nil && profile.TwentyFourSevenMode {
		m.log.Info("no listeners but 24/7 mode enabled, staying", "guild", e.GuildID)
		return
	}

	m.log.Info("no listeners remaining, leaving channel", "guild", e.GuildID)
	if textChannel != "" {
		embed := brandTitleEmbed(emoteSuccess+" | No one listening, leaving the channel!", "Thank you for using The Pack music bot.")
		_, _ = style.Send(m.session, textChannel, "", embed)
	}
	_ = m.Leave(context.Background(), e.GuildID)
}

// cleanup clears all guild state without emitting events. Filters reset too
// (parity: Node's filters lived on the Subscription, which died on leave).
func (m *Manager) cleanup(guildID string) {
	gp := m.Guild(guildID)
	gp.mu.Lock()
	gp.Queue = nil
	gp.History = nil
	gp.Current = nil
	gp.VoiceChannelID = ""
	gp.stopping = false
	gp.Filters = nil
	gp.mu.Unlock()
	m.notifyUpdate(guildID)
}

// --- session control ---

// Join connects to a voice channel and remembers the text channel for embeds.
func (m *Manager) Join(ctx context.Context, guildID, voiceChannelID, textChannelID string) error {
	gp := m.Guild(guildID)
	gp.mu.Lock()
	gp.TextChannelID = textChannelID
	alreadyThere := gp.VoiceChannelID == voiceChannelID
	gp.VoiceChannelID = voiceChannelID
	gp.mu.Unlock()

	player := m.client.Player(snowflake.MustParse(guildID))

	// Being in the channel is only sufficient if Lavalink also holds a live
	// voice connection. After a Lavalink restart the node comes back as a
	// fresh session with no voice credentials, so trusting our own state
	// here played audio into the void (found post-cutover: TrackEnd(cleanup)
	// with voice{} empty). Force a leave+rejoin to mint fresh credentials.
	if alreadyThere && player.State().Connected {
		return nil
	}
	if alreadyThere {
		m.log.Warn("in voice channel but Lavalink has no voice connection; rejoining", "guild", guildID)
		_ = m.session.ChannelVoiceJoinManual(guildID, "", false, false)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond): // let the disconnect land
		}
	}

	if err := m.session.ChannelVoiceJoinManual(guildID, voiceChannelID, false, true); err != nil {
		return fmt.Errorf("music: join voice channel: %w", err)
	}
	if err := m.waitForVoice(ctx, player); err != nil {
		return fmt.Errorf("music: voice connection: %w", err)
	}
	return nil
}

// Leave disconnects and clears state.
func (m *Manager) Leave(ctx context.Context, guildID string) error {
	gp := m.Guild(guildID)
	gp.mu.Lock()
	gp.stopping = true
	gp.mu.Unlock()

	if player := m.client.ExistingPlayer(snowflake.MustParse(guildID)); player != nil {
		_ = player.Update(ctx, lavalink.WithNullTrack())
	}
	err := m.session.ChannelVoiceJoinManual(guildID, "", false, false)
	m.cleanup(guildID)
	return err
}

// waitForVoice blocks until Lavalink reports the player's voice connection
// as established (or 10s pass). Connection state arrives via playerUpdate
// events, so playerUpdateInterval in application.yml bounds the latency.
func (m *Manager) waitForVoice(ctx context.Context, player disgolink.Player) error {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if player.State().Connected {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	return fmt.Errorf("not connected after 10s (voice events may not be reaching Lavalink)")
}

// --- queue operations ---

// Enqueue adds tracks and starts playback if idle. Returns the queue length
// after adding (for "Position in queue" embeds).
func (m *Manager) Enqueue(ctx context.Context, guildID string, tracks []*Track) (int, error) {
	gp := m.Guild(guildID)
	gp.mu.Lock()
	gp.Queue = append(gp.Queue, tracks...)
	queueLen := len(gp.Queue)
	idle := gp.Current == nil
	gp.mu.Unlock()
	m.notifyUpdate(guildID)

	if idle {
		if err := m.playNext(ctx, gp); err != nil {
			return queueLen, err
		}
	}
	return queueLen, nil
}

// playNext pops the queue head, resolves it if lazy, and starts it.
func (m *Manager) playNext(ctx context.Context, gp *GuildPlayer) error {
	gp.mu.Lock()
	if len(gp.Queue) == 0 {
		gp.Current = nil
		gp.mu.Unlock()
		return nil
	}
	next := gp.Queue[0]
	gp.Queue = gp.Queue[1:]
	gp.mu.Unlock()

	if err := m.resolveTrack(ctx, next); err != nil {
		m.log.Warn("failed to resolve track, skipping", "title", next.Title, "error", err)
		m.sendText(gp, errorEmbed(fmt.Sprintf("Couldn't play **%s** — skipping.", next.Title)))
		return m.playNext(ctx, gp)
	}

	gp.mu.Lock()
	gp.Current = next
	gp.stopping = false
	volume := gp.Volume
	filters := append([]string(nil), gp.Filters...)
	gp.mu.Unlock()

	// Filters are included on every start so the player always reflects the
	// guild's current set — including an empty set clearing leftovers after
	// filters were changed while idle.
	player := m.client.Player(snowflake.MustParse(gp.GuildID))
	err := player.Update(ctx,
		lavalink.WithTrack(*next.Encoded),
		lavalink.WithVolume(volume),
		lavalink.WithFilters(buildFilters(filters)),
	)
	if err != nil {
		return fmt.Errorf("music: start track: %w", err)
	}
	return nil
}

// Skip advances to the next track (announces via the skip embed).
func (m *Manager) Skip(ctx context.Context, guildID string, user string) error {
	gp := m.Guild(guildID)
	gp.mu.Lock()
	skipped := gp.Current
	if skipped == nil {
		gp.mu.Unlock()
		return fmt.Errorf("nothing playing")
	}
	gp.stopping = true
	gp.History = appendHistory(gp.History, skipped)
	hasNext := len(gp.Queue) > 0
	gp.mu.Unlock()

	embed := brandTitleEmbed(emoteSkip+" | Skipped: "+skipped.Title, "")
	if user != "" {
		embed.Description = "Skipped by " + user
	}
	m.sendText(gp, embed)
	m.notifyUpdate(guildID)

	if hasNext {
		return m.playNext(ctx, gp)
	}

	// Nothing queued: with autoplay on, skip flows into a related track
	// (improvement requested in live testing — Node just stopped here).
	gp.mu.Lock()
	autoplay := gp.Autoplay
	gp.mu.Unlock()
	if autoplay {
		if related := m.autoplayTrack(ctx, skipped, gp); related != nil {
			gp.mu.Lock()
			gp.Queue = append(gp.Queue, related)
			gp.mu.Unlock()
			m.log.Info("autoplay queued after skip", "title", related.Title)
			return m.playNext(ctx, gp)
		}
	}

	// Stop the player.
	gp.mu.Lock()
	gp.Current = nil
	gp.mu.Unlock()
	player := m.client.ExistingPlayer(snowflake.MustParse(guildID))
	if player != nil {
		return player.Update(ctx, lavalink.WithNullTrack())
	}
	return nil
}

// Stop clears the queue and stops playback (stays in the channel — /leave
// disconnects, parity with Node).
func (m *Manager) Stop(ctx context.Context, guildID string, user string) error {
	gp := m.Guild(guildID)
	gp.mu.Lock()
	gp.stopping = true
	gp.Queue = nil
	gp.History = nil
	gp.Current = nil
	gp.mu.Unlock()

	embed := brandTitleEmbed(emoteStop+" | Music stopped", "")
	if user != "" {
		embed.Description = "Stopped by " + user
	}
	m.sendText(gp, embed)
	m.notifyUpdate(guildID)

	if player := m.client.ExistingPlayer(snowflake.MustParse(guildID)); player != nil {
		return player.Update(ctx, lavalink.WithNullTrack())
	}
	return nil
}

// Previous replays the last history entry; the current track returns to the
// front of the queue.
func (m *Manager) Previous(ctx context.Context, guildID string) (*Track, error) {
	gp := m.Guild(guildID)
	gp.mu.Lock()
	if len(gp.History) == 0 {
		gp.mu.Unlock()
		return nil, fmt.Errorf("no previous track available")
	}
	prev := gp.History[len(gp.History)-1]
	gp.History = gp.History[:len(gp.History)-1]
	if gp.Current != nil {
		gp.Queue = append([]*Track{gp.Current}, gp.Queue...)
	}
	gp.stopping = true
	gp.Queue = append([]*Track{prev}, gp.Queue...)
	gp.mu.Unlock()

	return prev, m.playNext(ctx, gp)
}

// JumpTo plays the queue entry at index (0-based), pushing the current track
// to history.
func (m *Manager) JumpTo(ctx context.Context, guildID string, index int) (*Track, error) {
	gp := m.Guild(guildID)
	gp.mu.Lock()
	if index < 0 || index >= len(gp.Queue) {
		gp.mu.Unlock()
		return nil, fmt.Errorf("invalid queue position")
	}
	target := gp.Queue[index]
	gp.Queue = append(gp.Queue[:index], gp.Queue[index+1:]...)
	if gp.Current != nil {
		gp.History = appendHistory(gp.History, gp.Current)
	}
	gp.stopping = true
	gp.Queue = append([]*Track{target}, gp.Queue...)
	gp.mu.Unlock()

	return target, m.playNext(ctx, gp)
}

// Seek jumps to a position in the current track.
func (m *Manager) Seek(ctx context.Context, guildID string, to time.Duration) error {
	player := m.client.ExistingPlayer(snowflake.MustParse(guildID))
	if player == nil {
		return fmt.Errorf("nothing playing")
	}
	defer m.notifyUpdate(guildID)
	return player.Update(ctx, lavalink.WithPosition(lavalink.Duration(to.Milliseconds())))
}

// SetVolume sets playback volume (0–200, parity with Node).
func (m *Manager) SetVolume(ctx context.Context, guildID string, volume int) error {
	gp := m.Guild(guildID)
	gp.mu.Lock()
	gp.Volume = volume
	gp.mu.Unlock()
	m.notifyUpdate(guildID)
	if player := m.client.ExistingPlayer(snowflake.MustParse(guildID)); player != nil {
		return player.Update(ctx, lavalink.WithVolume(volume))
	}
	return nil
}

// SetPaused pauses/resumes; returns the previous state.
func (m *Manager) SetPaused(ctx context.Context, guildID string, paused bool) (bool, error) {
	player := m.client.ExistingPlayer(snowflake.MustParse(guildID))
	if player == nil {
		return false, fmt.Errorf("nothing playing")
	}
	was := player.Paused()
	defer m.notifyUpdate(guildID)
	return was, player.Update(ctx, lavalink.WithPaused(paused))
}

// Paused reports the player's pause state.
func (m *Manager) Paused(guildID string) bool {
	if player := m.client.ExistingPlayer(snowflake.MustParse(guildID)); player != nil {
		return player.Paused()
	}
	return false
}

// Position returns the live playback position of the current track.
func (m *Manager) Position(guildID string) time.Duration {
	if player := m.client.ExistingPlayer(snowflake.MustParse(guildID)); player != nil {
		return time.Duration(player.Position()) * time.Millisecond
	}
	return 0
}

func appendHistory(history []*Track, t *Track) []*Track {
	history = append(history, t)
	if len(history) > historyLimit {
		history = history[1:]
	}
	return history
}

// --- Lavalink events ---

func (m *Manager) onTrackStart(player disgolink.Player, event lavalink.TrackStartEvent) {
	guildID := player.GuildID().String()
	gp := m.Guild(guildID)
	gp.mu.Lock()
	current := gp.Current
	volume := gp.Volume
	repeat := gp.RepeatMode
	gp.mu.Unlock()
	if current == nil {
		return
	}
	m.log.Info("track started", "guild", guildID, "title", current.Title)
	m.notifyUpdate(guildID)

	// Now-playing embed (Node: playSong event in play.js).
	loop := "Off"
	if repeat != RepeatOff {
		loop = emoteRepeat + " "
		if repeat == RepeatQueue {
			loop += "All Queue"
		} else {
			loop += "This Song"
		}
	}
	embed := brandTitleEmbed(emotePlay+" | Now playing: "+current.Title, "")
	embed.URL = current.DisplayURL()
	embed.Fields = []*discordgo.MessageEmbedField{
		{Name: "Duration", Value: "`" + current.FormattedDuration() + "`", Inline: true},
		{Name: "Requested by", Value: current.Requester, Inline: true},
		{Name: "Volume", Value: fmt.Sprintf("`%d%%`", volume), Inline: true},
		{Name: "Loop", Value: loop, Inline: true},
	}
	if current.Thumbnail != "" {
		// Full-width art: this is the hero "now playing" moment (Ollie's
		// call after trying a corner thumbnail here). Utility cards
		// (/nowplaying, "Song added") keep compact thumbnails instead.
		embed.Image = &discordgo.MessageEmbedImage{URL: current.Thumbnail}
	}
	m.sendText(gp, embed)

	// Listening history (Node logged from playSong).
	if current.RequesterID != "" {
		username := "Unknown"
		if member, err := m.session.State.Member(guildID, current.RequesterID); err == nil && member.User != nil {
			username = member.User.Username
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := m.store.LogListen(ctx, guildID, current.RequesterID, username,
			current.Title, current.Artist, current.DisplayURL(), current.Thumbnail, int(current.Duration.Seconds()))
		cancel()
		if err != nil {
			m.log.Error("failed to log listening history", "error", err)
		}
	}
}

func (m *Manager) onTrackEnd(player disgolink.Player, event lavalink.TrackEndEvent) {
	guildID := player.GuildID().String()
	m.log.Info("track ended", "guild", guildID, "reason", event.Reason)
	gp := m.Guild(guildID)
	defer m.notifyUpdate(guildID)

	gp.mu.Lock()
	deliberate := gp.stopping
	gp.stopping = false
	gp.mu.Unlock()

	// REPLACED fires when we started the next track ourselves (skip/jump/
	// previous); STOPPED when we cleared deliberately. Only natural ends
	// (FINISHED) and failures advance the queue here.
	if deliberate || event.Reason == lavalink.TrackEndReasonReplaced || event.Reason == lavalink.TrackEndReasonStopped {
		return
	}
	if event.Reason == lavalink.TrackEndReasonCleanup {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	gp.mu.Lock()
	finished := gp.Current
	switch {
	case finished != nil && gp.RepeatMode == RepeatSong && event.Reason == lavalink.TrackEndReasonFinished:
		gp.Queue = append([]*Track{finished}, gp.Queue...)
	case finished != nil && gp.RepeatMode == RepeatQueue && event.Reason == lavalink.TrackEndReasonFinished:
		gp.Queue = append(gp.Queue, finished)
		gp.History = appendHistory(gp.History, finished)
	case finished != nil:
		gp.History = appendHistory(gp.History, finished)
	}
	gp.Current = nil
	queueEmpty := len(gp.Queue) == 0
	autoplay := gp.Autoplay
	gp.mu.Unlock()

	if queueEmpty && autoplay && finished != nil {
		if related := m.autoplayTrack(ctx, finished, gp); related != nil {
			gp.mu.Lock()
			gp.Queue = append(gp.Queue, related)
			queueEmpty = false
			gp.mu.Unlock()
			m.log.Info("autoplay queued", "title", related.Title)
		}
	}

	if queueEmpty {
		if event.Reason == lavalink.TrackEndReasonFinished {
			embed := brandTitleEmbed(emoteSuccess+" | Music finished!", "Thank you for using The Pack music bot.")
			m.sendText(gp, embed)
		}
		return
	}
	if err := m.playNext(ctx, gp); err != nil {
		m.log.Error("failed to advance queue", "guild", guildID, "error", err)
	}
}

// autoplayTrack finds a genuinely related track for autoplay. Primary
// source: the seed video's YouTube Mix ("radio") playlist — real related
// music, unlike a "<title> related" search whose top result is usually the
// seed itself (which made autoplay loop one song in live testing). Recent
// history and the seed are excluded so it can never repeat.
func (m *Manager) autoplayTrack(ctx context.Context, seed *Track, gp *GuildPlayer) *Track {
	exclude := make(map[string]bool)
	if seed.Encoded != nil {
		exclude[seed.Encoded.Info.Identifier] = true
	}
	gp.mu.Lock()
	historyTail := gp.History
	if len(historyTail) > 10 {
		historyTail = historyTail[len(historyTail)-10:]
	}
	for _, h := range historyTail {
		if h.Encoded != nil {
			exclude[h.Encoded.Info.Identifier] = true
		}
	}
	gp.mu.Unlock()

	// Dedupe by song identity too, not just video ID — the same song often
	// exists as multiple uploads (live testing: autoplay bounced back to the
	// seed song via a different video).
	excludeSongs := make(map[string]bool)
	songKey := func(title, artist string) string {
		return normalizeSongKey(title) + "|" + normalizeSongKey(artist)
	}
	excludeSongs[songKey(seed.Title, seed.Artist)] = true
	for _, h := range historyTail {
		excludeSongs[songKey(h.Title, h.Artist)] = true
	}

	pick := func(tracks []lavalink.Track) *Track {
		for _, lt := range tracks {
			if exclude[lt.Info.Identifier] {
				continue
			}
			if excludeSongs[songKey(lt.Info.Title, lt.Info.Author)] {
				continue
			}
			return fromLavalink(lt, seed.RequesterID, seed.Requester)
		}
		return nil
	}

	if seed.Encoded != nil && seed.Encoded.Info.SourceName == "youtube" {
		id := seed.Encoded.Info.Identifier
		mixURL := fmt.Sprintf("https://www.youtube.com/watch?v=%s&list=RD%s", id, id)
		if tracks, err := m.lavalinkSearchAll(ctx, mixURL); err == nil {
			if related := pick(tracks); related != nil {
				return related
			}
		} else {
			m.log.Warn("autoplay mix load failed", "error", err)
		}
	}

	// Fallback: related search with the same exclusions.
	query := fmt.Sprintf("%s %s related", seed.Artist, seed.Title)
	if tracks, err := m.lavalinkSearchAll(ctx, lavalink.SearchTypeYouTube.Apply(query)); err == nil {
		return pick(tracks)
	}
	return nil
}

func (m *Manager) onTrackException(player disgolink.Player, event lavalink.TrackExceptionEvent) {
	m.log.Error("track exception", "guild", player.GuildID(), "error", event.Exception.Message)
	// Login-wall exceptions mean the YouTube OAuth token died — alert the
	// admin by DM with the re-link steps (debounced; see ytauth.go).
	m.maybeNotifyAuthFailure(event.Exception.Message)
}

func (m *Manager) onTrackStuck(player disgolink.Player, event lavalink.TrackStuckEvent) {
	m.log.Warn("track stuck", "guild", player.GuildID(), "thresholdMs", event.Threshold)
}

// sendText posts an embed to the guild's music text channel.
func (m *Manager) sendText(gp *GuildPlayer, embed *discordgo.MessageEmbed) {
	gp.mu.Lock()
	channel := gp.TextChannelID
	gp.mu.Unlock()
	if channel == "" {
		return
	}
	if _, err := style.Send(m.session, channel, "", embed); err != nil {
		m.log.Error("failed to send music embed", "guild", gp.GuildID, "error", err)
	}
}
