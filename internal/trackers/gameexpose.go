package trackers

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"sync/atomic"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
)

const (
	minRecordedSession         = time.Minute
	exposeThreshold            = 6 * time.Hour
	playtimeCheckpointInterval = time.Minute
	presenceReorderWindow      = 25 * time.Millisecond
	gameEventBuffer            = 1024
)

type gameExposeStore interface {
	RecordPlaytime(ctx context.Context, guildID, userID, username, gameName string, seconds int64) error
	GuildProfile(ctx context.Context, guildID string) (*storage.GuildProfile, error)
}

// GameExpose tracks Playing activities, checkpoints qualifying sessions while
// they are active, and announces completed sessions of six hours or longer.
// All mutable session state is owned by Run's event loop.
type GameExpose struct {
	store gameExposeStore
	log   *slog.Logger

	events chan gameTrackerEvent
	done   chan struct{}

	shutdown atomic.Bool

	sessions        map[gameSessionKey]*gameSession
	endedSessions   map[uint64]*gameSession
	lastPresenceSeq map[userGuildKey]int64
	nextSessionID   uint64

	checkpointInterval time.Duration
	reorderWindow      time.Duration
	now                func() time.Time
}

type gameSessionKey struct {
	guildID    string
	userID     string
	activityID string
}

type userGuildKey struct {
	guildID string
	userID  string
}

type gameActivity struct {
	name           string
	applicationID  string
	startTimestamp int64
}

func (a gameActivity) identity() string {
	if a.applicationID != "" {
		return a.applicationID + "|" + a.name
	}
	return a.name
}

type presenceSnapshot struct {
	guildID    string
	userID     string
	username   string
	activities []gameActivity
}

type gameSession struct {
	id               uint64
	key              gameSessionKey
	game             string
	username         string
	startTimestamp   int64
	startedAt        time.Time
	accountedThrough time.Time
	pendingSeconds   int64
	endedAt          time.Time
	shouldAnnounce   bool
}

type gameTrackerEventKind uint8

const (
	gameGatewayEvent gameTrackerEventKind = iota
	gameConnectEvent
	gameDisconnectEvent
)

type gameTrackerEvent struct {
	kind      gameTrackerEventKind
	sequence  int64
	presences []presenceSnapshot
}

// NewGameExpose builds the tracker.
func NewGameExpose(store gameExposeStore) *GameExpose {
	g := &GameExpose{
		store:              store,
		log:                slog.With("tracker", "game-expose"),
		events:             make(chan gameTrackerEvent, gameEventBuffer),
		done:               make(chan struct{}),
		sessions:           make(map[gameSessionKey]*gameSession),
		endedSessions:      make(map[uint64]*gameSession),
		lastPresenceSeq:    make(map[userGuildKey]int64),
		checkpointInterval: playtimeCheckpointInterval,
		reorderWindow:      presenceReorderWindow,
		now:                time.Now,
	}
	return g
}

// HandleGatewayEvent consumes raw gateway events so presence updates retain
// their Discord sequence number. Typed handlers do not expose that number and
// discordgo invokes them concurrently.
func (g *GameExpose) HandleGatewayEvent(s *discordgo.Session, event *discordgo.Event) {
	if event == nil || g.shutdown.Load() {
		return
	}

	var snapshots []presenceSnapshot
	switch payload := event.Struct.(type) {
	case *discordgo.PresenceUpdate:
		if snapshot, ok := snapshotPresence(s, payload.GuildID, &payload.Presence); ok {
			snapshots = append(snapshots, snapshot)
		}
	case *discordgo.GuildCreate:
		if payload.Guild == nil {
			return
		}
		for _, presence := range payload.Presences {
			if snapshot, ok := snapshotPresence(s, payload.ID, presence); ok {
				snapshots = append(snapshots, snapshot)
			}
		}
	default:
		return
	}

	if len(snapshots) != 0 {
		g.enqueue(gameTrackerEvent{kind: gameGatewayEvent, sequence: event.Sequence, presences: snapshots})
	}
}

// HandleConnect seeds sessions from discordgo's cached presences after a
// resumed connection. Initial GuildCreate events seed a fresh connection.
func (g *GameExpose) HandleConnect(s *discordgo.Session, _ *discordgo.Connect) {
	if g.shutdown.Load() {
		return
	}
	g.enqueue(gameTrackerEvent{kind: gameConnectEvent, presences: snapshotCachedPresences(s)})
}

// HandleDisconnect closes observed sessions at the disconnect boundary so a
// gateway outage is never counted as confirmed playtime.
func (g *GameExpose) HandleDisconnect(_ *discordgo.Session, _ *discordgo.Disconnect) {
	if g.shutdown.Load() {
		return
	}
	g.enqueue(gameTrackerEvent{kind: gameDisconnectEvent})
}

func (g *GameExpose) enqueue(event gameTrackerEvent) {
	select {
	case g.events <- event:
	case <-g.done:
	}
}

// StopAccepting freezes gateway input before a graceful shutdown drain.
func (g *GameExpose) StopAccepting() { g.shutdown.Store(true) }

// Done closes after Run has drained accepted events and stopped.
func (g *GameExpose) Done() <-chan struct{} { return g.done }

// Run owns session mutation, checkpointing, persistence retries, and event
// reordering. It must be started exactly once.
func (g *GameExpose) Run(ctx context.Context, s *discordgo.Session) {
	defer close(g.done)

	checkpoint := time.NewTicker(g.checkpointInterval)
	defer checkpoint.Stop()

	var reorderTimer *time.Timer
	var reorderC <-chan time.Time
	var buffered []gameTrackerEvent

	stopReorderTimer := func() {
		if reorderTimer == nil {
			return
		}
		if !reorderTimer.Stop() {
			select {
			case <-reorderTimer.C:
			default:
			}
		}
		reorderC = nil
	}

	flushGateway := func() {
		stopReorderTimer()
		if len(buffered) == 0 {
			return
		}
		sort.SliceStable(buffered, func(i, j int) bool { return buffered[i].sequence < buffered[j].sequence })
		shouldPersist := false
		for _, event := range buffered {
			if g.applyGatewayEvent(event) {
				shouldPersist = true
			}
		}
		buffered = buffered[:0]
		if shouldPersist {
			g.persistPending(ctx, s)
		}
	}

	for {
		select {
		case <-ctx.Done():
			for {
				select {
				case event := <-g.events:
					if event.kind == gameGatewayEvent {
						buffered = append(buffered, event)
					} else {
						flushGateway()
						g.applyControlEvent(event)
					}
				default:
					flushGateway()
					return
				}
			}

		case event := <-g.events:
			if event.kind != gameGatewayEvent {
				flushGateway()
				g.applyControlEvent(event)
				g.persistPending(ctx, s)
				continue
			}
			buffered = append(buffered, event)
			if reorderC == nil {
				if reorderTimer == nil {
					reorderTimer = time.NewTimer(g.reorderWindow)
				} else {
					reorderTimer.Reset(g.reorderWindow)
				}
				reorderC = reorderTimer.C
			}

		case <-reorderC:
			flushGateway()

		case now := <-checkpoint.C:
			flushGateway()
			g.checkpointActive(now)
			g.persistPending(ctx, s)
		}
	}
}
func (g *GameExpose) applyGatewayEvent(event gameTrackerEvent) bool {
	ended := false
	for _, presence := range event.presences {
		key := userGuildKey{guildID: presence.guildID, userID: presence.userID}
		if previous, ok := g.lastPresenceSeq[key]; ok && event.sequence <= previous {
			continue
		}
		g.lastPresenceSeq[key] = event.sequence
		if g.applyPresence(presence, g.now()) {
			ended = true
		}
	}
	return ended
}

func (g *GameExpose) applyControlEvent(event gameTrackerEvent) {
	now := g.now()
	switch event.kind {
	case gameConnectEvent:
		g.lastPresenceSeq = make(map[userGuildKey]int64)
		for _, presence := range event.presences {
			g.applyPresence(presence, now)
		}
	case gameDisconnectEvent:
		g.endAll(now, false)
	}
}

func (g *GameExpose) applyPresence(presence presenceSnapshot, now time.Time) bool {
	current := make(map[string]gameActivity, len(presence.activities))
	for _, activity := range presence.activities {
		current[activity.identity()] = activity
	}

	ended := false
	for identity, activity := range current {
		key := gameSessionKey{guildID: presence.guildID, userID: presence.userID, activityID: identity}
		if existing, ok := g.sessions[key]; ok {
			if existing.startTimestamp != 0 && activity.startTimestamp != 0 &&
				existing.startTimestamp != activity.startTimestamp {
				g.endSession(existing, now, true)
				delete(g.sessions, key)
				ended = true
			} else {
				if presence.username != "Unknown" {
					existing.username = presence.username
				}
				continue
			}
		}

		g.nextSessionID++
		g.sessions[key] = &gameSession{
			id:               g.nextSessionID,
			key:              key,
			game:             activity.name,
			username:         presence.username,
			startTimestamp:   activity.startTimestamp,
			startedAt:        now,
			accountedThrough: now,
		}
	}

	for key, session := range g.sessions {
		if key.guildID != presence.guildID || key.userID != presence.userID {
			continue
		}
		if _, stillPlaying := current[key.activityID]; stillPlaying {
			continue
		}
		g.endSession(session, now, true)
		delete(g.sessions, key)
		ended = true
	}
	return ended
}

func (g *GameExpose) checkpointActive(now time.Time) {
	for _, session := range g.sessions {
		g.accrue(session, now)
	}
}

func (g *GameExpose) endAll(now time.Time, announce bool) {
	for key, session := range g.sessions {
		g.endSession(session, now, announce)
		delete(g.sessions, key)
	}
}

func (g *GameExpose) endSession(session *gameSession, now time.Time, announce bool) {
	if now.Before(session.startedAt) {
		now = session.startedAt
	}
	duration := now.Sub(session.startedAt)
	if duration < minRecordedSession {
		return
	}
	g.accrue(session, now)
	session.endedAt = now
	session.shouldAnnounce = announce && duration >= exposeThreshold
	g.endedSessions[session.id] = session
}

func (g *GameExpose) accrue(session *gameSession, now time.Time) {
	if now.Sub(session.startedAt) < minRecordedSession || !now.After(session.accountedThrough) {
		return
	}
	seconds := int64(now.Sub(session.accountedThrough) / time.Second)
	if seconds <= 0 {
		return
	}
	session.pendingSeconds += seconds
	session.accountedThrough = session.accountedThrough.Add(time.Duration(seconds) * time.Second)
}

func (g *GameExpose) persistPending(parent context.Context, s *discordgo.Session) {
	for _, session := range g.sessions {
		g.persistSession(parent, session)
	}
	for id, session := range g.endedSessions {
		if !g.persistSession(parent, session) {
			continue
		}
		if session.shouldAnnounce {
			g.announce(parent, s, session)
		}
		delete(g.endedSessions, id)
	}
}

// persistSession returns true when the session has no unpersisted whole
// seconds. Failed additive writes retain the exact delta for the next retry.
func (g *GameExpose) persistSession(parent context.Context, session *gameSession) bool {
	if session.pendingSeconds == 0 {
		return true
	}
	seconds := session.pendingSeconds
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	err := g.store.RecordPlaytime(ctx, session.key.guildID, session.key.userID, session.username, session.game, seconds)
	cancel()
	if err != nil {
		g.log.Error("failed to record playtime",
			"guild", session.key.guildID, "user", session.key.userID,
			"game", session.game, "seconds", seconds, "error", err)
		return false
	}
	g.log.Debug("recorded playtime checkpoint",
		"guild", session.key.guildID, "user", session.key.userID,
		"game", session.game, "seconds", seconds)
	session.pendingSeconds -= seconds
	return session.pendingSeconds == 0
}

// Flush ends active observations without exposing them and retries every
// pending delta. Call after StopAccepting and Run have returned.
func (g *GameExpose) Flush(ctx context.Context, s *discordgo.Session) {
	g.endAll(g.now(), false)
	g.persistPending(ctx, s)
}

func (g *GameExpose) announce(parent context.Context, s *discordgo.Session, session *gameSession) {
	if s == nil {
		return
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	profile, err := g.store.GuildProfile(ctx, session.key.guildID)
	cancel()
	if err != nil || profile.GeneralChannelID == nil || *profile.GeneralChannelID == "" {
		return
	}

	elapsed := session.endedAt.Sub(session.startedAt)
	msg := fmt.Sprintf("%s played **%s** for %.2f hours!", session.username, session.game, elapsed.Hours())
	if _, err := s.ChannelMessageSend(*profile.GeneralChannelID, msg); err != nil {
		g.log.Error("failed to send game-expose message", "guild", session.key.guildID, "error", err)
	}
}

func snapshotPresence(s *discordgo.Session, guildID string, presence *discordgo.Presence) (presenceSnapshot, bool) {
	if guildID == "" || presence == nil || presence.User == nil || presence.User.ID == "" {
		return presenceSnapshot{}, false
	}

	username, isBot := cachedPresenceUser(s, guildID, presence.User)
	if isBot {
		return presenceSnapshot{}, false
	}

	snapshot := presenceSnapshot{guildID: guildID, userID: presence.User.ID, username: username}
	for _, activity := range presence.Activities {
		if activity == nil || activity.Type != discordgo.ActivityTypeGame || activity.Name == "" {
			continue
		}
		snapshot.activities = append(snapshot.activities, gameActivity{
			name:           activity.Name,
			applicationID:  activity.ApplicationID,
			startTimestamp: activity.Timestamps.StartTimestamp,
		})
	}
	return snapshot, true
}

func cachedPresenceUser(s *discordgo.Session, guildID string, user *discordgo.User) (string, bool) {
	if user == nil {
		return "Unknown", false
	}
	if user.Username != "" {
		return user.Username, user.Bot
	}
	if s != nil && s.State != nil {
		if member, err := s.State.Member(guildID, user.ID); err == nil && member.User != nil {
			if member.User.Username != "" {
				return member.User.Username, member.User.Bot
			}
			return "Unknown", member.User.Bot
		}
	}
	return "Unknown", user.Bot
}

func snapshotCachedPresences(s *discordgo.Session) []presenceSnapshot {
	if s == nil || s.State == nil {
		return nil
	}

	type cachedPresence struct {
		guildID string
		value   discordgo.Presence
	}
	var cached []cachedPresence

	s.State.RLock()
	for _, guild := range s.State.Guilds {
		if guild == nil {
			continue
		}
		for _, presence := range guild.Presences {
			if presence == nil {
				continue
			}
			copyPresence := *presence
			if presence.User != nil {
				copyUser := *presence.User
				copyPresence.User = &copyUser
			}
			copyPresence.Activities = make([]*discordgo.Activity, 0, len(presence.Activities))
			for _, activity := range presence.Activities {
				if activity == nil {
					continue
				}
				copyActivity := *activity
				copyPresence.Activities = append(copyPresence.Activities, &copyActivity)
			}
			cached = append(cached, cachedPresence{guildID: guild.ID, value: copyPresence})
		}
	}
	s.State.RUnlock()

	var snapshots []presenceSnapshot
	for i := range cached {
		if snapshot, ok := snapshotPresence(s, cached[i].guildID, &cached[i].value); ok {
			snapshots = append(snapshots, snapshot)
		}
	}
	return snapshots
}
