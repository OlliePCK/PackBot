package media

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
)

const (
	lifecycleGuildID       = "773732791585865769"
	lifecycleGeneralID     = "773732792051040268"
	lifecycleOtherChannel  = "773732792051040269"
	lifecycleMessageID     = "999999999999999999"
	lifecycleChannelID     = "57f44ef3ee6b38a4bea6a9fd001d1aec"
	lifecycleChannelIDUUID = "57F44EF3-EE6B-38A4-BEA6-A9FD001D1AEC"
	lifecycleViewerID      = "11111111222233334444555555555555"
	lifecycleFriendID      = "aaaaaaaa222233334444555555555555"
)

func TestServiceConfirmedLifecycleEditsViewerChangesAndDeletesOnStop(t *testing.T) {
	ctx := context.Background()
	source := &lifecycleSource{}
	store := newLifecycleStore()
	messenger := &lifecycleMessenger{}
	service := newLifecycleService(t, source, store, messenger)
	if err := service.restore(ctx); err != nil {
		t.Fatalf("restore: %v", err)
	}

	// The empty startup snapshot initializes suppression without creating a
	// channel lifecycle.
	service.poll(ctx)
	source.sessions = []LiveTVSession{lifecycleSession(lifecycleViewerID)}
	service.poll(ctx)
	if got := len(messenger.sends); got != 0 {
		t.Fatalf("sends after first observation = %d, want 0", got)
	}

	service.poll(ctx)
	if got := len(messenger.sends); got != 1 {
		t.Fatalf("sends after confirmation = %d, want 1", got)
	}
	if got := messenger.sends[0].channelID; got != lifecycleGeneralID {
		t.Errorf("send destination = %q, want %q", got, lifecycleGeneralID)
	}
	if got := messenger.sends[0].view.Viewers; !reflect.DeepEqual(got, []string{"Ollie"}) {
		t.Errorf("sent viewers = %#v, want Ollie", got)
	}
	if store.claims != 1 || store.activations != 1 {
		t.Errorf("claims/activations = %d/%d, want 1/1", store.claims, store.activations)
	}

	source.sessions = []LiveTVSession{
		lifecycleSession(lifecycleViewerID),
		lifecycleSession(lifecycleFriendID),
	}
	service.poll(ctx)
	if got := len(messenger.edits); got != 1 {
		t.Fatalf("edits after viewer change = %d, want 1", got)
	}
	if got := messenger.edits[0].view.Viewers; !reflect.DeepEqual(got, []string{"Friend", "Ollie"}) {
		t.Errorf("edited viewers = %#v, want Friend and Ollie", got)
	}
	if store.touches != 1 {
		t.Errorf("touches = %d, want 1", store.touches)
	}

	source.sessions = nil
	service.poll(ctx)
	if got := len(messenger.deletes); got != 0 {
		t.Fatalf("deletes after one missing snapshot = %d, want 0", got)
	}
	service.poll(ctx)
	if got := len(messenger.deletes); got != 1 {
		t.Fatalf("deletes after stop grace = %d, want 1", got)
	}
	if got := messenger.deletes[0]; got.channelID != lifecycleGeneralID || got.messageID != lifecycleMessageID {
		t.Errorf("deleted message = %#v", got)
	}
	if store.deletions != 1 {
		t.Errorf("store deletions = %d, want 1", store.deletions)
	}
}

func TestServiceSuppressesLifecycleAlreadyActiveAtStartup(t *testing.T) {
	ctx := context.Background()
	source := &lifecycleSource{sessions: []LiveTVSession{lifecycleSession(lifecycleViewerID)}}
	store := newLifecycleStore()
	messenger := &lifecycleMessenger{}
	service := newLifecycleService(t, source, store, messenger)
	if err := service.restore(ctx); err != nil {
		t.Fatalf("restore: %v", err)
	}

	for range 3 {
		service.poll(ctx)
	}
	if got := len(messenger.sends); got != 0 {
		t.Fatalf("startup lifecycle sends = %d, want 0", got)
	}

	source.sessions = nil
	service.poll(ctx)
	service.poll(ctx)
	source.sessions = []LiveTVSession{lifecycleSession(lifecycleViewerID)}
	service.poll(ctx)
	service.poll(ctx)
	if got := len(messenger.sends); got != 1 {
		t.Fatalf("new lifecycle sends = %d, want 1", got)
	}
}

func TestServiceRestoresPublishedCardWithoutDuplicateSend(t *testing.T) {
	ctx := context.Background()
	firstSeen := time.Date(2026, 7, 19, 5, 0, 0, 0, time.UTC)
	store := newLifecycleStore()
	store.seed(storage.MediaLiveCard{
		GuildID:           lifecycleGuildID,
		JellyfinChannelID: lifecycleChannelIDUUID,
		DiscordChannelID:  lifecycleGeneralID,
		DiscordMessageID:  lifecycleMessageID,
		Status:            storage.MediaCardActive,
		FirstSeenAt:       firstSeen,
		LastSeenAt:        firstSeen,
	})
	source := &lifecycleSource{sessions: []LiveTVSession{lifecycleSession(lifecycleViewerID)}}
	messenger := &lifecycleMessenger{}
	service := newLifecycleService(t, source, store, messenger)
	if err := service.restore(ctx); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if _, ok := service.cards[lifecycleChannelID]; !ok {
		t.Fatalf("restored card was not keyed by canonical Jellyfin ID")
	}

	service.poll(ctx)
	if len(messenger.sends) != 0 || len(messenger.edits) != 1 {
		t.Fatalf("first restored snapshot sends/edits = %d/%d, want 0/1",
			len(messenger.sends), len(messenger.edits))
	}
	if got := messenger.edits[0].view.StartedAt; !got.Equal(firstSeen) {
		t.Errorf("first restored edit StartedAt = %v, want %v", got, firstSeen)
	}

	source.sessions = []LiveTVSession{
		lifecycleSession(lifecycleViewerID),
		lifecycleSession(lifecycleFriendID),
	}
	service.poll(ctx)
	if got := len(messenger.sends); got != 0 {
		t.Fatalf("restored lifecycle duplicate sends = %d, want 0", got)
	}
	if got := len(messenger.edits); got != 2 {
		t.Fatalf("restored lifecycle edits = %d, want 2", got)
	}
	edit := messenger.edits[1]
	if edit.channelID != lifecycleGeneralID || edit.messageID != lifecycleMessageID {
		t.Errorf("restored edit target = %q/%q", edit.channelID, edit.messageID)
	}
	if !edit.view.StartedAt.Equal(firstSeen) {
		t.Errorf("restored StartedAt = %v, want %v", edit.view.StartedAt, firstSeen)
	}
}

func TestServiceFetchErrorDoesNotCountAsMissingSnapshot(t *testing.T) {
	ctx := context.Background()
	source := &lifecycleSource{}
	store := newLifecycleStore()
	messenger := &lifecycleMessenger{}
	service := newLifecycleService(t, source, store, messenger)
	if err := service.restore(ctx); err != nil {
		t.Fatalf("restore: %v", err)
	}

	service.poll(ctx)
	source.sessions = []LiveTVSession{lifecycleSession(lifecycleViewerID)}
	service.poll(ctx)
	service.poll(ctx)
	if got := len(messenger.sends); got != 1 {
		t.Fatalf("confirmed sends = %d, want 1", got)
	}

	source.err = errors.New("temporary Jellyfin failure")
	service.poll(ctx)
	source.err = nil
	source.sessions = nil
	service.poll(ctx)
	if got := len(messenger.deletes); got != 0 {
		t.Fatalf("fetch error consumed stop grace; deletes = %d", got)
	}

	// Seeing the channel again resets the one real missing observation.
	source.sessions = []LiveTVSession{lifecycleSession(lifecycleViewerID)}
	service.poll(ctx)
	source.sessions = nil
	service.poll(ctx)
	if got := len(messenger.deletes); got != 0 {
		t.Fatalf("delete after reset plus one miss = %d, want 0", got)
	}
	service.poll(ctx)
	if got := len(messenger.deletes); got != 1 {
		t.Fatalf("delete after two consecutive misses = %d, want 1", got)
	}
}

func TestServiceRejectsIntentForAnyOtherDestination(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name    string
		guildID string
		destID  string
	}{
		{name: "wrong guild", guildID: "773732791585865768", destID: lifecycleGeneralID},
		{name: "wrong channel", guildID: lifecycleGuildID, destID: lifecycleOtherChannel},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			source := &lifecycleSource{}
			store := newLifecycleStore()
			messenger := &lifecycleMessenger{}
			service := newLifecycleService(t, source, store, messenger)
			service.handleIntent(ctx, Intent{
				Kind:                 IntentUpsert,
				MainGuildID:          tt.guildID,
				DestinationChannelID: tt.destID,
				Channel:              lifecycleView(),
				At:                   time.Now(),
			})
			if store.claims != 0 || len(messenger.sends) != 0 || len(messenger.edits) != 0 {
				t.Fatalf("mismatched intent reached delivery: claims=%d sends=%d edits=%d",
					store.claims, len(messenger.sends), len(messenger.edits))
			}
		})
	}
}

func TestServiceAmbiguousSendRetainsPendingClaimAndNeverResends(t *testing.T) {
	ctx := context.Background()
	source := &lifecycleSource{}
	store := newLifecycleStore()
	messenger := &lifecycleMessenger{sendErr: errors.New("ambiguous Discord timeout")}
	service := newLifecycleService(t, source, store, messenger)
	if err := service.restore(ctx); err != nil {
		t.Fatalf("restore: %v", err)
	}

	service.poll(ctx)
	source.sessions = []LiveTVSession{lifecycleSession(lifecycleViewerID)}
	service.poll(ctx)
	service.poll(ctx)
	if store.claims != 1 || len(messenger.sends) != 1 {
		t.Fatalf("ambiguous attempt claims/sends = %d/%d, want 1/1", store.claims, len(messenger.sends))
	}
	card, ok := store.card(lifecycleChannelID)
	if !ok || card.Status != storage.MediaCardPending || card.DiscordMessageID != "" {
		t.Fatalf("ambiguous persisted state = %#v, present=%v", card, ok)
	}

	// Even a changed public view must not risk a second Discord send once the
	// outcome of the first call is unknown.
	messenger.sendErr = nil
	source.sessions = []LiveTVSession{
		lifecycleSession(lifecycleViewerID),
		lifecycleSession(lifecycleFriendID),
	}
	service.poll(ctx)
	service.poll(ctx)
	if got := len(messenger.sends); got != 1 {
		t.Fatalf("ambiguous delivery was resent %d times, want exactly 1 total", got)
	}
	if store.activations != 0 {
		t.Errorf("ambiguous delivery activations = %d, want 0", store.activations)
	}

	// A restart restores the pending row as a block, not permission to send.
	restartedMessenger := &lifecycleMessenger{}
	restarted := newLifecycleService(t, source, store, restartedMessenger)
	if err := restarted.restore(ctx); err != nil {
		t.Fatalf("restart restore: %v", err)
	}
	restarted.poll(ctx)
	restarted.poll(ctx)
	if got := len(restartedMessenger.sends); got != 0 {
		t.Fatalf("pending claim was resent after restart: %d", got)
	}
}

func TestServiceDefiniteDiscordRejectionReleasesClaimAndRetries(t *testing.T) {
	ctx := context.Background()
	source := &lifecycleSource{}
	store := newLifecycleStore()
	messenger := &lifecycleMessenger{
		sendErr: fmt.Errorf("wrapped Discord rejection: %w", lifecycleRESTError(http.StatusForbidden)),
	}
	service := newLifecycleService(t, source, store, messenger)
	if err := service.restore(ctx); err != nil {
		t.Fatalf("restore: %v", err)
	}

	service.poll(ctx)
	source.sessions = []LiveTVSession{lifecycleSession(lifecycleViewerID)}
	service.poll(ctx)
	service.poll(ctx)

	if store.claims != 1 || store.releases != 1 || len(messenger.sends) != 1 {
		t.Fatalf(
			"rejected attempt claims/releases/sends = %d/%d/%d, want 1/1/1",
			store.claims,
			store.releases,
			len(messenger.sends),
		)
	}
	if card, ok := store.card(lifecycleChannelID); ok {
		t.Fatalf("definitively rejected send retained card state: %#v", card)
	}

	// The released claim remains retryable. flushPending runs before the next
	// Jellyfin snapshot and can safely create exactly one message.
	messenger.sendErr = nil
	service.poll(ctx)
	if store.claims != 2 || store.activations != 1 || len(messenger.sends) != 2 {
		t.Fatalf(
			"retry claims/activations/sends = %d/%d/%d, want 2/1/2",
			store.claims,
			store.activations,
			len(messenger.sends),
		)
	}
	if card, ok := store.card(lifecycleChannelID); !ok || card.Status != storage.MediaCardActive {
		t.Fatalf("retry did not activate card: %#v, present=%v", card, ok)
	}
}

func TestDefiniteDiscordSendFailureClassification(t *testing.T) {
	rateLimit := &discordgo.RateLimitError{RateLimit: &discordgo.RateLimit{
		TooManyRequests: &discordgo.TooManyRequests{RetryAfter: time.Second},
		URL:             "https://discord.example/messages",
	}}
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "bad request", err: lifecycleRESTError(http.StatusBadRequest), want: true},
		{name: "unauthorized", err: lifecycleRESTError(http.StatusUnauthorized), want: true},
		{name: "forbidden wrapped", err: fmt.Errorf("send: %w", lifecycleRESTError(http.StatusForbidden)), want: true},
		{name: "not found", err: lifecycleRESTError(http.StatusNotFound), want: true},
		{name: "rate limited", err: rateLimit, want: true},
		{name: "server error", err: lifecycleRESTError(http.StatusInternalServerError), want: false},
		{name: "REST error without response", err: &discordgo.RESTError{}, want: false},
		{name: "transport error", err: errors.New("connection reset"), want: false},
		{name: "nil", err: nil, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isDefiniteDiscordSendFailure(tt.err); got != tt.want {
				t.Errorf("isDefiniteDiscordSendFailure() = %v, want %v", got, tt.want)
			}
		})
	}
}

func lifecycleRESTError(status int) error {
	return &discordgo.RESTError{Response: &http.Response{
		StatusCode: status,
		Status:     fmt.Sprintf("%d %s", status, http.StatusText(status)),
	}}
}

func TestServiceNormalizesJellyfinIDsAtEveryBoundary(t *testing.T) {
	ctx := context.Background()
	cfg := lifecycleConfig()
	// The config uses the database UUID form while the API session uses the
	// compact DTO form.
	if _, ok := cfg.Channels[lifecycleChannelIDUUID]; !ok {
		t.Fatal("test setup must use UUID-form config key")
	}
	source := &lifecycleSource{}
	store := newLifecycleStore()
	messenger := &lifecycleMessenger{}
	service, err := newService(cfg, 15*time.Second, source, store, messenger)
	if err != nil {
		t.Fatalf("newService: %v", err)
	}
	if _, ok := service.cfg.Channels[lifecycleChannelID]; !ok {
		t.Fatalf("normalized config does not contain %q", lifecycleChannelID)
	}
	if err := service.restore(ctx); err != nil {
		t.Fatalf("restore: %v", err)
	}

	service.poll(ctx)
	source.sessions = []LiveTVSession{lifecycleSession(lifecycleViewerID)}
	service.poll(ctx)
	service.poll(ctx)
	card, ok := store.card(lifecycleChannelID)
	if !ok {
		t.Fatalf("claim did not use canonical channel ID")
	}
	if card.JellyfinChannelID != lifecycleChannelID {
		t.Errorf("stored channel ID = %q, want %q", card.JellyfinChannelID, lifecycleChannelID)
	}
}

type lifecycleSource struct {
	sessions []LiveTVSession
	err      error
}

func (s *lifecycleSource) LiveTVSessions(context.Context) ([]LiveTVSession, error) {
	if s.err != nil {
		return nil, s.err
	}
	return append([]LiveTVSession(nil), s.sessions...), nil
}

type lifecycleStore struct {
	initial       []storage.MediaLiveCard
	cards         map[string]storage.MediaLiveCard
	rejectClaims  bool
	claims        int
	releases      int
	activations   int
	touches       int
	deletions     int
	deletedGuilds []string
	deletedIDs    []string
	listErr       error
	claimErr      error
	releaseErr    error
	activationErr error
	touchErr      error
	deleteErr     error
}

func newLifecycleStore() *lifecycleStore {
	return &lifecycleStore{cards: make(map[string]storage.MediaLiveCard)}
}

func (s *lifecycleStore) seed(card storage.MediaLiveCard) {
	s.initial = append(s.initial, card)
	s.cards[canonicalJellyfinID(card.JellyfinChannelID)] = card
}

func (s *lifecycleStore) card(channelID string) (storage.MediaLiveCard, bool) {
	card, ok := s.cards[canonicalJellyfinID(channelID)]
	return card, ok
}

func (s *lifecycleStore) MediaLiveCards(context.Context, string) ([]storage.MediaLiveCard, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	return append([]storage.MediaLiveCard(nil), s.initial...), nil
}

func (s *lifecycleStore) ClaimMediaLiveCard(
	_ context.Context,
	guildID, jellyfinChannelID, discordChannelID string,
	firstSeenAt time.Time,
) (bool, error) {
	s.claims++
	if s.claimErr != nil {
		return false, s.claimErr
	}
	key := canonicalJellyfinID(jellyfinChannelID)
	if s.rejectClaims {
		return false, nil
	}
	if _, exists := s.cards[key]; exists {
		return false, nil
	}
	s.cards[key] = storage.MediaLiveCard{
		GuildID:           guildID,
		JellyfinChannelID: jellyfinChannelID,
		DiscordChannelID:  discordChannelID,
		Status:            storage.MediaCardPending,
		FirstSeenAt:       firstSeenAt,
		LastSeenAt:        firstSeenAt,
	}
	return true, nil
}

func (s *lifecycleStore) ReleaseMediaLiveCard(
	_ context.Context,
	guildID, jellyfinChannelID, discordChannelID string,
) error {
	s.releases++
	if s.releaseErr != nil {
		return s.releaseErr
	}
	key := canonicalJellyfinID(jellyfinChannelID)
	card, exists := s.cards[key]
	if !exists ||
		card.GuildID != guildID ||
		card.DiscordChannelID != discordChannelID ||
		card.Status != storage.MediaCardPending ||
		card.DiscordMessageID != "" {
		return errors.New("release did not match a pending delivery")
	}
	delete(s.cards, key)
	return nil
}

func (s *lifecycleStore) ActivateMediaLiveCard(
	_ context.Context,
	guildID, jellyfinChannelID, discordChannelID, discordMessageID string,
	lastSeenAt time.Time,
) error {
	s.activations++
	if s.activationErr != nil {
		return s.activationErr
	}
	key := canonicalJellyfinID(jellyfinChannelID)
	card := s.cards[key]
	card.GuildID = guildID
	card.JellyfinChannelID = jellyfinChannelID
	card.DiscordChannelID = discordChannelID
	card.DiscordMessageID = discordMessageID
	card.Status = storage.MediaCardActive
	card.LastSeenAt = lastSeenAt
	s.cards[key] = card
	return nil
}

func (s *lifecycleStore) TouchMediaLiveCard(
	_ context.Context,
	_, jellyfinChannelID, _ string,
	lastSeenAt time.Time,
) error {
	s.touches++
	if s.touchErr != nil {
		return s.touchErr
	}
	key := canonicalJellyfinID(jellyfinChannelID)
	card := s.cards[key]
	card.LastSeenAt = lastSeenAt
	s.cards[key] = card
	return nil
}

func (s *lifecycleStore) DeleteMediaLiveCard(
	_ context.Context,
	guildID, jellyfinChannelID string,
) error {
	s.deletions++
	s.deletedGuilds = append(s.deletedGuilds, guildID)
	s.deletedIDs = append(s.deletedIDs, jellyfinChannelID)
	if s.deleteErr != nil {
		return s.deleteErr
	}
	delete(s.cards, canonicalJellyfinID(jellyfinChannelID))
	return nil
}

type lifecycleMessageCall struct {
	channelID string
	messageID string
	view      ChannelView
}

type lifecycleMessenger struct {
	sends     []lifecycleMessageCall
	edits     []lifecycleMessageCall
	deletes   []lifecycleMessageCall
	sendErr   error
	editErr   error
	deleteErr error
}

func (m *lifecycleMessenger) Send(channelID string, view ChannelView) (string, error) {
	m.sends = append(m.sends, lifecycleMessageCall{
		channelID: channelID,
		view:      cloneLifecycleView(view),
	})
	if m.sendErr != nil {
		return "", m.sendErr
	}
	return lifecycleMessageID, nil
}

func (m *lifecycleMessenger) Edit(channelID, messageID string, view ChannelView) error {
	m.edits = append(m.edits, lifecycleMessageCall{
		channelID: channelID,
		messageID: messageID,
		view:      cloneLifecycleView(view),
	})
	return m.editErr
}

func (m *lifecycleMessenger) Delete(channelID, messageID string) error {
	m.deletes = append(m.deletes, lifecycleMessageCall{
		channelID: channelID,
		messageID: messageID,
	})
	return m.deleteErr
}

func newLifecycleService(
	t *testing.T,
	source *lifecycleSource,
	store *lifecycleStore,
	messenger *lifecycleMessenger,
) *Service {
	t.Helper()
	service, err := newService(lifecycleConfig(), 15*time.Second, source, store, messenger)
	if err != nil {
		t.Fatalf("newService: %v", err)
	}
	return service
}

func lifecycleConfig() Config {
	return Config{
		MainGuildID:          lifecycleGuildID,
		GeneralChannelID:     lifecycleGeneralID,
		ConfirmationPolls:    2,
		EndAfterMissingPolls: 2,
		UnknownViewerPolicy:  AnonymizeUnknownViewers,
		ViewerAliases: map[string]string{
			lifecycleViewerID: "Ollie",
			lifecycleFriendID: "Friend",
		},
		Channels: map[string]ChannelConfig{
			lifecycleChannelIDUUID: {
				DisplayName: "Fox Sports 503",
				WatchURL: "https://jellyfin.example/web/#/details?id=" +
					lifecycleChannelID,
			},
		},
	}
}

func lifecycleSession(viewerID string) LiveTVSession {
	return LiveTVSession{
		ViewerID:    viewerID,
		ChannelID:   lifecycleChannelID,
		ChannelName: "untrusted provider channel",
		ProgramID:   "program-1",
		ProgramName: "Sydney v Adelaide",
	}
}

func lifecycleView() ChannelView {
	return ChannelView{
		ChannelID:   lifecycleChannelID,
		ChannelName: "Fox Sports 503",
		WatchURL: "https://jellyfin.example/web/#/details?id=" +
			lifecycleChannelID,
		ProgramID:   "program-1",
		ProgramName: "Sydney v Adelaide",
		Viewers:     []string{"Ollie"},
		StartedAt:   time.Now(),
	}
}

func cloneLifecycleView(view ChannelView) ChannelView {
	view.Viewers = append([]string(nil), view.Viewers...)
	return view
}
