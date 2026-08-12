package commands

import "testing"

func TestSetPropertyReplacesWithoutDisturbingOtherKeys(t *testing.T) {
	in := "#Minecraft server properties\ndifficulty=hard\nlevel-seed=oldseed\nhardcore=true\n"
	got := setProperty(in, "level-seed", "12345")
	want := "#Minecraft server properties\ndifficulty=hard\nlevel-seed=12345\nhardcore=true\n"
	if got != want {
		t.Fatalf("setProperty:\n got %q\nwant %q", got, want)
	}
}

func TestSetPropertyClearsValueForRandomSeed(t *testing.T) {
	got := setProperty("level-seed=abc\nhardcore=true\n", "level-seed", "")
	want := "level-seed=\nhardcore=true\n"
	if got != want {
		t.Fatalf("setProperty: got %q want %q", got, want)
	}
}

func TestSetPropertyAppendsMissingKey(t *testing.T) {
	got := setProperty("hardcore=true\n", "level-seed", "42")
	want := "hardcore=true\n\nlevel-seed=42"
	if got != want {
		t.Fatalf("setProperty: got %q want %q", got, want)
	}
}

func TestSetPropertyHandlesCRLF(t *testing.T) {
	got := setProperty("difficulty=hard\r\nlevel-seed=old\r\n", "level-seed", "new")
	want := "difficulty=hard\r\nlevel-seed=new\n"
	if got != want {
		t.Fatalf("setProperty: got %q want %q", got, want)
	}
}

// The seed is interpolated into a key=value file, so anything that could start
// a new line or a new key must be rejected before it gets there.
func TestSeedPatternRejectsInjection(t *testing.T) {
	bad := []string{
		"12345\nenable-rcon=true",
		"12345\r\nwhite-list=false",
		"seed=other",
		"a b",
		"",
		"../../etc/passwd",
		"12345;",
	}
	for _, s := range bad {
		if mcSeedRe.MatchString(s) {
			t.Errorf("mcSeedRe accepted dangerous seed %q", s)
		}
	}

	good := []string{"12345", "-12345", "PackCraft_2", "a"}
	for _, s := range good {
		if !mcSeedRe.MatchString(s) {
			t.Errorf("mcSeedRe rejected valid seed %q", s)
		}
	}
}

func TestOnlinePlayerPatternParsesVanillaOutput(t *testing.T) {
	m := mcOnlineRe.FindStringSubmatch(
		"There are 3 of a max of 20 players online: Ollie, Rin, Max")
	if m == nil || m[1] != "3" {
		t.Fatalf("mcOnlineRe failed to parse player count: %v", m)
	}
	if m := mcOnlineRe.FindStringSubmatch("There are 0 of a max of 20 players online:"); m == nil || m[1] != "0" {
		t.Fatalf("mcOnlineRe failed on empty server: %v", m)
	}
}
