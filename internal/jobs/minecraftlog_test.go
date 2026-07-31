package jobs

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/OlliePCK/packbot/internal/minecraft"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func appendFile(t *testing.T, path, content string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		t.Fatalf("append: %v", err)
	}
}

func TestTailerSkipsExistingContent(t *testing.T) {
	// Startup must not replay the session's history as fresh events.
	path := filepath.Join(t.TempDir(), "latest.log")
	writeFile(t, path, "[10:00:00] [Server thread/INFO]: OlliePCK joined the game\n")

	tl := &logTailer{path: path}
	lines, err := tl.readLines()
	if err != nil {
		t.Fatalf("readLines: %v", err)
	}
	if len(lines) != 0 {
		t.Errorf("first read returned %d lines, want 0", len(lines))
	}
}

func TestTailerReadsAppendedLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "latest.log")
	writeFile(t, path, "old\n")

	tl := &logTailer{path: path}
	tl.readLines() // establish the baseline

	appendFile(t, path, "one\ntwo\n")
	lines, err := tl.readLines()
	if err != nil {
		t.Fatalf("readLines: %v", err)
	}
	if len(lines) != 2 || lines[0] != "one" || lines[1] != "two" {
		t.Errorf("lines = %v, want [one two]", lines)
	}

	if lines, _ := tl.readLines(); len(lines) != 0 {
		t.Errorf("second read returned %v, want nothing new", lines)
	}
}

func TestTailerHoldsPartialLine(t *testing.T) {
	// A line still being written must not be parsed as two broken halves.
	path := filepath.Join(t.TempDir(), "latest.log")
	writeFile(t, path, "old\n")

	tl := &logTailer{path: path}
	tl.readLines()

	appendFile(t, path, "[10:00:00] [Server thread/INFO]: Ollie")
	if lines, _ := tl.readLines(); len(lines) != 0 {
		t.Fatalf("partial line surfaced early: %v", lines)
	}

	appendFile(t, path, "PCK joined the game\n")
	lines, _ := tl.readLines()
	if len(lines) != 1 {
		t.Fatalf("lines = %v, want one complete line", lines)
	}
	ev, ok := minecraft.ParseLogLine(lines[0])
	if !ok || ev.Player != "OlliePCK" {
		t.Errorf("reassembled line parsed as %+v", ev)
	}
}

func TestTailerHandlesTruncation(t *testing.T) {
	// Minecraft rotates latest.log on restart; a shorter file means start over.
	path := filepath.Join(t.TempDir(), "latest.log")
	writeFile(t, path, "aaaa\nbbbb\ncccc\n")

	tl := &logTailer{path: path}
	tl.readLines()

	writeFile(t, path, "fresh\n") // rotated: new, shorter file
	lines, err := tl.readLines()
	if err != nil {
		t.Fatalf("readLines: %v", err)
	}
	if len(lines) != 1 || lines[0] != "fresh" {
		t.Errorf("lines = %v, want [fresh] after rotation", lines)
	}
}

func TestRenderLogEvent(t *testing.T) {
	tests := []struct {
		ev       minecraft.LogEvent
		contains string
	}{
		{minecraft.LogEvent{Kind: minecraft.EventJoin, Player: "OlliePCK"}, "OlliePCK joined"},
		{minecraft.LogEvent{Kind: minecraft.EventLeave, Player: "OlliePCK"}, "OlliePCK left"},
		{minecraft.LogEvent{Kind: minecraft.EventAdvancement, Player: "OlliePCK", Detail: "Stone Age"}, "Stone Age"},
		{minecraft.LogEvent{Kind: minecraft.EventDeath, Player: "fretnim", Detail: "was slain by Enderman"}, "was slain by Enderman"},
	}
	for _, tc := range tests {
		got := renderLogEvent(tc.ev)
		if got == "" || !contains(got, tc.contains) {
			t.Errorf("renderLogEvent(%+v) = %q, want it to contain %q", tc.ev, got, tc.contains)
		}
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle ||
		len(needle) == 0 || indexOf(haystack, needle) >= 0)
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}
