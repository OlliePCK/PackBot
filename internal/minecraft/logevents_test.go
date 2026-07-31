package minecraft

import "testing"

func TestParseJoinLeave(t *testing.T) {
	tests := []struct {
		line   string
		kind   EventKind
		player string
	}{
		{"[18:34:29] [Server thread/INFO]: OlliePCK joined the game", EventJoin, "OlliePCK"},
		{"[23:54:01] [Server thread/INFO]: 2lwaterbottle left the game", EventLeave, "2lwaterbottle"},
		{"[11:11:00] [Server thread/INFO]: Mr___Ed joined the game", EventJoin, "Mr___Ed"},
	}
	for _, tc := range tests {
		ev, ok := ParseLogLine(tc.line)
		if !ok {
			t.Errorf("ParseLogLine(%q) returned no event", tc.line)
			continue
		}
		if ev.Kind != tc.kind || ev.Player != tc.player {
			t.Errorf("ParseLogLine(%q) = %v/%q, want %v/%q", tc.line, ev.Kind, ev.Player, tc.kind, tc.player)
		}
	}
}

func TestParseAdvancement(t *testing.T) {
	tests := []struct{ line, player, detail string }{
		{"[18:37:11] [Server thread/INFO]: OlliePCK has made the advancement [Stone Age]", "OlliePCK", "Stone Age"},
		{"[22:56:00] [Server thread/INFO]: fretnim has made the advancement [The End?]", "fretnim", "The End?"},
		{"[23:34:00] [Server thread/INFO]: Proudyfoot has reached the goal [Sky's the Limit]", "Proudyfoot", "Sky's the Limit"},
		{"[23:35:00] [Server thread/INFO]: Itswooza has completed the challenge [How Did We Get Here?]", "Itswooza", "How Did We Get Here?"},
	}
	for _, tc := range tests {
		ev, ok := ParseLogLine(tc.line)
		if !ok || ev.Kind != EventAdvancement {
			t.Errorf("ParseLogLine(%q) did not yield an advancement", tc.line)
			continue
		}
		if ev.Player != tc.player || ev.Detail != tc.detail {
			t.Errorf("got %q/%q, want %q/%q", ev.Player, ev.Detail, tc.player, tc.detail)
		}
	}
}

func TestParseDeaths(t *testing.T) {
	// Drawn from the real messages the old server posted, plus common vanilla
	// variants.
	tests := []struct{ line, player, detail string }{
		{"[22:57:00] [Server thread/INFO]: fretnim was slain by Enderman", "fretnim", "was slain by Enderman"},
		{"[22:59:00] [Server thread/INFO]: fretnim was killed by Ender Dragon using magic", "fretnim", "was killed by Ender Dragon using magic"},
		{"[23:00:00] [Server thread/INFO]: Itswooza fell from a high place", "Itswooza", "fell from a high place"},
		{"[23:01:00] [Server thread/INFO]: fretnim was doomed to fall by Ender Dragon", "fretnim", "was doomed to fall by Ender Dragon"},
		{"[23:13:00] [Server thread/INFO]: OlliePCK fell out of the world", "OlliePCK", "fell out of the world"},
		{"[23:17:00] [Server thread/INFO]: fretnim was shot by Proudyfoot using [PEW PEW]", "fretnim", "was shot by Proudyfoot using [PEW PEW]"},
		{"[23:54:00] [Server thread/INFO]: OlliePCK drowned", "OlliePCK", "drowned"},
		{"[10:00:00] [Server thread/INFO]: OlliePCK tried to swim in lava", "OlliePCK", "tried to swim in lava"},
		{"[10:00:00] [Server thread/INFO]: OlliePCK discovered the floor was lava", "OlliePCK", "discovered the floor was lava"},
		{"[10:00:00] [Server thread/INFO]: OlliePCK blew up", "OlliePCK", "blew up"},
		{"[10:00:00] [Server thread/INFO]: OlliePCK starved to death", "OlliePCK", "starved to death"},
		{"[10:00:00] [Server thread/INFO]: OlliePCK suffocated in a wall", "OlliePCK", "suffocated in a wall"},
	}
	for _, tc := range tests {
		ev, ok := ParseLogLine(tc.line)
		if !ok || ev.Kind != EventDeath {
			t.Errorf("ParseLogLine(%q) did not yield a death", tc.line)
			continue
		}
		if ev.Player != tc.player || ev.Detail != tc.detail {
			t.Errorf("got %q/%q, want %q/%q", ev.Player, ev.Detail, tc.player, tc.detail)
		}
	}
}

func TestParseIgnoresNonEvents(t *testing.T) {
	// Real lines from the server that must not be mistaken for gameplay.
	lines := []string{
		"[18:25:05] [ServerMain/INFO]: Loaded 1617 advancements",
		"[18:36:57] [RCON Listener #1/INFO]: Thread RCON Client /172.18.0.1 started",
		"[18:36:58] [RCON Client /172.18.0.1 #3/INFO]: Thread RCON Client shutting down",
		"[18:34:29] [Server thread/INFO]: OlliePCK[/172.18.0.1:39436] logged in with entity id 1 at (...)",
		"[18:25:05] [Server thread/INFO]: Done (7.658s)! For help, type \"help\"",
		"[18:25:05] [Server thread/WARN]: OlliePCK was slain by Enderman",
		"[18:25:05] [Server thread/INFO]: Preparing spawn area: 100%",
		"[18:25:05] [Server thread/INFO]: [CoreProtect] CoreProtect has been enabled!",
		"not a log line at all",
		"",
	}
	for _, line := range lines {
		if ev, ok := ParseLogLine(line); ok {
			t.Errorf("ParseLogLine(%q) wrongly produced %v for %q", line, ev.Kind, ev.Player)
		}
	}
}

func TestParseRejectsInvalidUsernames(t *testing.T) {
	// Too short and too long must not match, so console text starting with a
	// short word isn't read as a player.
	lines := []string{
		"[10:00:00] [Server thread/INFO]: ab drowned",
		"[10:00:00] [Server thread/INFO]: ThisNameIsFarTooLong drowned",
	}
	for _, line := range lines {
		if _, ok := ParseLogLine(line); ok {
			t.Errorf("ParseLogLine(%q) should not match", line)
		}
	}
}
