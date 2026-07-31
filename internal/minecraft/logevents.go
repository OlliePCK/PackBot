package minecraft

import (
	"regexp"
	"strings"
)

// EventKind classifies a parsed server-log line.
type EventKind int

const (
	EventJoin EventKind = iota
	EventLeave
	EventAdvancement
	EventDeath
)

// LogEvent is one player-visible thing that happened on the server.
type LogEvent struct {
	Kind   EventKind
	Player string
	// Detail is the advancement name, or the death message with the player's
	// name stripped ("was slain by Enderman").
	Detail string
}

// logLineRe splits "[18:34:29] [Server thread/INFO]: message" into its thread
// tag and message.
//
// Only "Server thread/INFO" lines carry player events. Anchoring on that
// discards RCON chatter, worker threads, plugin startup logging and warnings,
// which is the cheapest way to avoid misreading console output as gameplay.
var logLineRe = regexp.MustCompile(`^\[\d{2}:\d{2}:\d{2}\] \[Server thread/INFO\]: (.*)$`)

// playerName is the leading username in an event message. Matching the same
// shape as a real Minecraft username keeps arbitrary console text from being
// read as a player action.
const playerName = `([A-Za-z0-9_]{3,16})`

var (
	joinRe  = regexp.MustCompile(`^` + playerName + ` joined the game$`)
	leaveRe = regexp.MustCompile(`^` + playerName + ` left the game$`)

	// Advancements come in three flavours: normal, goal and challenge.
	advancementRe = regexp.MustCompile(
		`^` + playerName + ` has (?:made the advancement|reached the goal|completed the challenge) \[(.+)\]$`)

	// deathRe matches the verb phrases vanilla uses for death messages.
	//
	// Death lines carry no marker of their own — they are bare INFO lines
	// shaped exactly like console output — so this is a maintained list rather
	// than a rule, and it will need extending as Mojang adds messages. The job
	// additionally requires the named player to be online, which is what keeps
	// a false positive here from becoming a wrong Discord post.
	deathRe = regexp.MustCompile(`^` + playerName + ` ((?:` + strings.Join([]string{
		`was (?:slain|shot|pummelled|fireballed|killed|blown up|squashed|skewered|impaled|stung|struck|roasted|frozen|doomed|squished|poked|pricked|obliterated|burnt|shot by|killed by)\b.*`,
		`walked into (?:a cactus|the danger zone|fire)\b.*`,
		`drowned.*`,
		`experienced kinetic energy.*`,
		`blew up.*`,
		`hit the ground too hard.*`,
		`fell (?:from a high place|off .*|out of the world|into .*|while climbing.*).*`,
		`went off with a bang.*`,
		`went up in flames.*`,
		`tried to swim in lava.*`,
		`burned to death.*`,
		`discovered the floor was lava.*`,
		`suffocated in a wall.*`,
		`starved to death.*`,
		`withered away.*`,
		`died.*`,
		`left the confines of this world.*`,
		`didn't want to live in the same world as .*`,
		`froze to death.*`,
	}, "|") + `))$`)
)

// ParseLogLine extracts a player event from one server-log line.
//
// The bool reports whether the line was an event at all; the overwhelming
// majority of log lines are not.
func ParseLogLine(line string) (LogEvent, bool) {
	m := logLineRe.FindStringSubmatch(strings.TrimRight(line, "\r\n"))
	if m == nil {
		return LogEvent{}, false
	}
	msg := strings.TrimSpace(m[1])

	if g := joinRe.FindStringSubmatch(msg); g != nil {
		return LogEvent{Kind: EventJoin, Player: g[1]}, true
	}
	if g := leaveRe.FindStringSubmatch(msg); g != nil {
		return LogEvent{Kind: EventLeave, Player: g[1]}, true
	}
	if g := advancementRe.FindStringSubmatch(msg); g != nil {
		return LogEvent{Kind: EventAdvancement, Player: g[1], Detail: g[2]}, true
	}
	if g := deathRe.FindStringSubmatch(msg); g != nil {
		return LogEvent{Kind: EventDeath, Player: g[1], Detail: g[2]}, true
	}
	return LogEvent{}, false
}
