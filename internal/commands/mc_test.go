package commands

import "testing"

// The username pattern is the guard between Discord input and a console
// command executed with operator authority, so it is tested as a security
// control rather than as input tidying.
func TestMCUsernameValidation(t *testing.T) {
	valid := []string{
		"OlliePCK",
		"abc",              // minimum length
		"A_1234567890123",  // 16 chars
		"_underscore_",
		"1234",
	}
	for _, name := range valid {
		if !mcUsernameRe.MatchString(name) {
			t.Errorf("%q should be accepted", name)
		}
	}

	invalid := []string{
		"",
		"ab",                  // too short
		"A_12345678901234567", // too long
		"Ollie PCK",           // space: would append a second argument
		"Ollie\nop Attacker",  // newline injection
		"Ollie\rop Attacker",  // carriage return
		"Ollie;op Attacker",
		"Ollie&&op Attacker",
		"@everyone",
		"Ollie\"quoted\"",
		"Ollie'quoted'",
		"../../etc/passwd",
		"Ollie§c",
		"Öllie", // non-ASCII
	}
	for _, name := range invalid {
		if mcUsernameRe.MatchString(name) {
			t.Errorf("%q should be rejected", name)
		}
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("short", 100); got != "short" {
		t.Errorf("truncate kept = %q, want unchanged", got)
	}
	got := truncate("abcdefghij", 5)
	if len([]rune(got)) != 5 {
		t.Errorf("truncate(%q, 5) = %q, want 5 runes", "abcdefghij", got)
	}
}

func TestFallback(t *testing.T) {
	if got := fallback("", "unknown"); got != "unknown" {
		t.Errorf("fallback(empty) = %q, want unknown", got)
	}
	if got := fallback("   ", "unknown"); got != "unknown" {
		t.Errorf("fallback(blank) = %q, want unknown", got)
	}
	if got := fallback("Paper 26.1.2", "unknown"); got != "Paper 26.1.2" {
		t.Errorf("fallback(set) = %q", got)
	}
}
