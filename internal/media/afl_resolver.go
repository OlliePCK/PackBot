package media

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	aflProgramLookback   = 2 * time.Hour
	aflProgramStartGrace = 30 * time.Minute
	aflProgramEndGrace   = 10 * time.Minute
)

// AFLMatchQuery is intentionally independent of the AFL package so the media
// integration remains an optional adapter at the kickoff-card boundary.
type AFLMatchQuery struct {
	Home    string
	Away    string
	Kickoff time.Time
}

// AFLBroadcastState is the safe button label for a resolved broadcast.
type AFLBroadcastState string

const (
	// AFLBroadcastJoin means the resolved channel already owns the upstream
	// slot, so another viewer can share that exact live channel.
	AFLBroadcastJoin AFLBroadcastState = "Join"
	// AFLBroadcastWatch means no Live TV channel currently owns the slot.
	AFLBroadcastWatch AFLBroadcastState = "Watch"
)

// AFLBroadcast contains only metadata safe to attach to a Discord card. The
// URL is a token-free Jellyfin Web item page, never a direct stream URL.
type AFLBroadcast struct {
	ChannelID   string
	ChannelName string
	WatchURL    string
	State       AFLBroadcastState
}

// AFLBroadcastResolver matches an AFL fixture to current Jellyfin guide data.
// orderedChannelIDs is both an allowlist and the deterministic preference
// order (for example Fox Sports 503, Fox Sports 504, then Seven).
type AFLBroadcastResolver struct {
	programs          LiveTVProgramsSource
	publicJellyfinURL url.URL
	channelIDs        []string
	channelPriority   map[string]int
}

// NewAFLBroadcastResolver validates and copies the ordered channel allowlist.
func NewAFLBroadcastResolver(
	programs LiveTVProgramsSource,
	publicJellyfinURL string,
	orderedChannelIDs []string,
) (*AFLBroadcastResolver, error) {
	if programs == nil {
		return nil, fmt.Errorf("media: Live TV programs source is required")
	}
	channelIDs, err := normalizeOrderedChannelIDs(orderedChannelIDs)
	if err != nil {
		return nil, err
	}

	publicURL, err := url.Parse(strings.TrimSpace(publicJellyfinURL))
	if err != nil || publicURL.Scheme != "https" || publicURL.Host == "" {
		return nil, fmt.Errorf("media: public Jellyfin URL must be an absolute HTTPS URL")
	}
	if publicURL.User != nil || publicURL.RawQuery != "" || publicURL.Fragment != "" {
		return nil, fmt.Errorf("media: public Jellyfin URL must not contain credentials, query, or fragment")
	}
	publicURL.Path = strings.TrimRight(publicURL.Path, "/")
	publicURL.RawPath = ""

	priority := make(map[string]int, len(channelIDs))
	for index, channelID := range channelIDs {
		priority[channelID] = index
	}
	return &AFLBroadcastResolver{
		programs:          programs,
		publicJellyfinURL: *publicURL,
		channelIDs:        append([]string(nil), channelIDs...),
		channelPriority:   priority,
	}, nil
}

// Resolve returns nil without error when the guide is ambiguous/unmatched, or
// when a different Live TV channel occupies the one available upstream slot.
// activeSessions must be a complete current Live TV snapshot.
func (r *AFLBroadcastResolver) Resolve(
	ctx context.Context,
	match AFLMatchQuery,
	activeSessions []LiveTVSession,
) (*AFLBroadcast, error) {
	normalizedMatch, err := normalizeAFLMatch(match)
	if err != nil {
		return nil, err
	}

	minEndDate := normalizedMatch.Kickoff.Add(-aflProgramEndGrace)
	maxStartDate := normalizedMatch.Kickoff.Add(aflProgramStartGrace)
	programs, err := r.programs.LiveTVPrograms(ctx, r.channelIDs, minEndDate, maxStartDate)
	if err != nil {
		return nil, fmt.Errorf("media: resolve AFL broadcast: %w", err)
	}

	candidates := r.matchingCandidates(normalizedMatch, programs)
	if len(candidates) == 0 {
		return nil, nil
	}

	activeChannels := make(map[string]struct{})
	for _, session := range activeSessions {
		if channelID := CanonicalJellyfinID(session.ChannelID); channelID != "" {
			activeChannels[channelID] = struct{}{}
		}
	}

	// One distinct active channel may be shared. Multiple active channels are
	// ambiguous (usually stale session state), so fail closed rather than offer
	// a link that might consume another upstream connection.
	if len(activeChannels) == 1 {
		for _, candidate := range candidates {
			if _, active := activeChannels[candidate.ChannelID]; active {
				return r.broadcast(candidate, AFLBroadcastJoin)
			}
		}
		return nil, nil
	}
	if len(activeChannels) > 1 {
		return nil, nil
	}
	return r.broadcast(candidates[0], AFLBroadcastWatch)
}

func (r *AFLBroadcastResolver) matchingCandidates(
	match AFLMatchQuery,
	programs []LiveTVProgram,
) []programCandidate {
	homeAliases, homeIdentity := aliasesForAFLTeam(match.Home)
	awayAliases, awayIdentity := aliasesForAFLTeam(match.Away)
	if homeIdentity == awayIdentity {
		return nil
	}

	candidates := make([]programCandidate, 0, len(programs))
	for _, program := range programs {
		channelID := CanonicalJellyfinID(program.ChannelID)
		priority, allowed := r.channelPriority[channelID]
		if !allowed || !programInAFLWindow(match.Kickoff, program) {
			continue
		}

		channelName := safeChannelName(program.ChannelName)
		if channelName == "" || !programMatchesAFL(program, homeAliases, awayAliases) {
			continue
		}
		program.ChannelID = channelID
		program.ChannelName = channelName
		candidates = append(candidates, programCandidate{
			LiveTVProgram: program,
			priority:      priority,
			startDelta:    absoluteDuration(program.Start.Sub(match.Kickoff)),
		})
	}

	sort.Slice(candidates, func(i, j int) bool {
		left, right := candidates[i], candidates[j]
		if left.priority != right.priority {
			return left.priority < right.priority
		}
		if left.startDelta != right.startDelta {
			return left.startDelta < right.startDelta
		}
		if !left.Start.Equal(right.Start) {
			return left.Start.Before(right.Start)
		}
		if left.ID != right.ID {
			return left.ID < right.ID
		}
		return left.ChannelName < right.ChannelName
	})
	return candidates
}

func (r *AFLBroadcastResolver) broadcast(
	program programCandidate,
	state AFLBroadcastState,
) (*AFLBroadcast, error) {
	watchURL, err := PublicChannelURL(r.publicJellyfinURL.String(), program.ChannelID)
	if err != nil {
		return nil, err
	}
	return &AFLBroadcast{
		ChannelID:   program.ChannelID,
		ChannelName: program.ChannelName,
		WatchURL:    watchURL,
		State:       state,
	}, nil
}

type programCandidate struct {
	LiveTVProgram
	priority   int
	startDelta time.Duration
}

func normalizeAFLMatch(match AFLMatchQuery) (AFLMatchQuery, error) {
	match.Home = cleanText(match.Home)
	match.Away = cleanText(match.Away)
	if match.Home == "" || match.Away == "" {
		return AFLMatchQuery{}, fmt.Errorf("media: AFL match teams are required")
	}
	if match.Kickoff.IsZero() {
		return AFLMatchQuery{}, fmt.Errorf("media: AFL match kickoff is required")
	}
	_, homeIdentity := aliasesForAFLTeam(match.Home)
	_, awayIdentity := aliasesForAFLTeam(match.Away)
	if homeIdentity == awayIdentity {
		return AFLMatchQuery{}, fmt.Errorf("media: AFL match teams must be different")
	}
	return match, nil
}

func programInAFLWindow(kickoff time.Time, program LiveTVProgram) bool {
	if program.Start.IsZero() || program.End.IsZero() || !program.Start.Before(program.End) {
		return false
	}
	if program.Start.Before(kickoff.Add(-aflProgramLookback)) {
		return false
	}
	if program.Start.After(kickoff.Add(aflProgramStartGrace)) {
		return false
	}
	return !program.End.Before(kickoff.Add(-aflProgramEndGrace))
}

func programMatchesAFL(program LiveTVProgram, homeAliases, awayAliases []string) bool {
	parts := []string{program.Name, program.SeriesName, program.Overview}
	parts = append(parts, program.Genres...)
	parts = append(parts, program.Tags...)
	searchable := normalizeSearchText(strings.Join(parts, " "))
	if searchable == "" || isAFLWText(searchable) || !hasAFLContext(searchable) {
		return false
	}
	return containsDistinctTeamPhrases(searchable, homeAliases, awayAliases)
}

func hasAFLContext(normalized string) bool {
	return containsPhrase(normalized, "afl") ||
		containsPhrase(normalized, "australian rules") ||
		containsPhrase(normalized, "australian rules football") ||
		containsPhrase(normalized, "australian football league") ||
		containsPhrase(normalized, "aussie rules")
}

func isAFLWText(normalized string) bool {
	if containsPhrase(normalized, "aflw") || containsPhrase(normalized, "afl w") {
		return true
	}
	if !hasAFLContext(normalized) {
		return false
	}
	for _, marker := range []string{"women", "womens", "female", "girls"} {
		if containsPhrase(normalized, marker) {
			return true
		}
	}
	return false
}

func containsPhrase(normalized, phrase string) bool {
	phrase = normalizeSearchText(phrase)
	if normalized == "" || phrase == "" {
		return false
	}
	return strings.Contains(" "+normalized+" ", " "+phrase+" ")
}

func normalizeSearchText(value string) string {
	var normalized strings.Builder
	normalized.Grow(len(value))
	space := true
	for _, r := range strings.ToLower(value) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			normalized.WriteRune(r)
			space = false
			continue
		}
		if !space {
			normalized.WriteByte(' ')
			space = true
		}
	}
	return strings.TrimSpace(normalized.String())
}

func safeChannelName(value string) string {
	value = strings.Join(strings.Fields(cleanText(value)), " ")
	value = strings.ReplaceAll(value, "@", "@\u200b")
	const maxRunes = 100
	if utf8.RuneCountInString(value) <= maxRunes {
		return value
	}
	runes := []rune(value)
	return strings.TrimSpace(string(runes[:maxRunes-1])) + "…"
}

func absoluteDuration(value time.Duration) time.Duration {
	if value < 0 {
		return -value
	}
	return value
}

var aflTeamAliasSets = map[string][]string{
	"adelaide": {
		"adelaide", "adelaide crows", "crows",
	},
	"brisbane lions": {
		"brisbane lions", "brisbane", "lions",
	},
	"carlton": {
		"carlton", "carlton blues", "blues",
	},
	"collingwood": {
		"collingwood", "collingwood magpies", "magpies", "pies",
	},
	"essendon": {
		"essendon", "essendon bombers", "bombers",
	},
	"fremantle": {
		"fremantle", "fremantle dockers", "dockers", "freo",
	},
	"geelong": {
		"geelong", "geelong cats", "cats",
	},
	"gold coast": {
		"gold coast", "gold coast suns", "suns",
	},
	"greater western sydney": {
		"greater western sydney", "greater western sydney giants", "gws", "gws giants", "giants",
	},
	"hawthorn": {
		"hawthorn", "hawthorn hawks", "hawks",
	},
	"melbourne": {
		"melbourne", "melbourne demons", "demons",
	},
	"north melbourne": {
		"north melbourne", "north melbourne kangaroos", "kangaroos", "roos",
	},
	"port adelaide": {
		"port adelaide", "port adelaide power", "power",
	},
	"richmond": {
		"richmond", "richmond tigers", "tigers",
	},
	"st kilda": {
		"st kilda", "st kilda saints", "saints",
	},
	"sydney": {
		"sydney", "sydney swans", "swans",
	},
	"west coast": {
		"west coast", "west coast eagles", "eagles",
	},
	"western bulldogs": {
		"western bulldogs", "bulldogs", "dogs",
	},
}

func aliasesForAFLTeam(team string) ([]string, string) {
	normalized := normalizeSearchText(team)
	for canonical, aliases := range aflTeamAliasSets {
		if normalized == canonical {
			return aliases, canonical
		}
		for _, alias := range aliases {
			if normalized == alias {
				return aliases, canonical
			}
		}
	}
	return []string{normalized}, normalized
}
