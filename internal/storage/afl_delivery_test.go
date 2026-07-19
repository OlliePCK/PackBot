package storage

import (
	"encoding/hex"
	"errors"
	"io/fs"
	"strings"
	"testing"

	"github.com/OlliePCK/packbot/database"
)

func TestValidateAflAnnouncementKey(t *testing.T) {
	valid := AflAnnouncementKey{
		GuildID:     "123456789",
		Kind:        "kickoff",
		GameID:      "38653",
		KickoffUnix: 1784266800,
	}
	if err := validateAflAnnouncementKey(valid); err != nil {
		t.Fatalf("valid key rejected: %v", err)
	}

	tests := []struct {
		name string
		key  AflAnnouncementKey
	}{
		{"missing guild", AflAnnouncementKey{Kind: "kickoff", GameID: "38653", KickoffUnix: 1}},
		{"long guild", AflAnnouncementKey{GuildID: strings.Repeat("g", 33), Kind: "kickoff", GameID: "38653", KickoffUnix: 1}},
		{"missing kind", AflAnnouncementKey{GuildID: "guild", GameID: "38653", KickoffUnix: 1}},
		{"long kind", AflAnnouncementKey{GuildID: "guild", Kind: strings.Repeat("k", 33), GameID: "38653", KickoffUnix: 1}},
		{"missing game", AflAnnouncementKey{GuildID: "guild", Kind: "kickoff", KickoffUnix: 1}},
		{"long game", AflAnnouncementKey{GuildID: "guild", Kind: "kickoff", GameID: strings.Repeat("g", 65), KickoffUnix: 1}},
		{"missing kickoff", AflAnnouncementKey{GuildID: "guild", Kind: "kickoff", GameID: "38653"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateAflAnnouncementKey(tt.key); err == nil {
				t.Fatal("invalid key was accepted")
			}
		})
	}
}

func TestAflClaimToken(t *testing.T) {
	first, err := aflClaimToken()
	if err != nil {
		t.Fatalf("first token: %v", err)
	}
	second, err := aflClaimToken()
	if err != nil {
		t.Fatalf("second token: %v", err)
	}
	if first == second {
		t.Fatal("independent claims received the same token")
	}
	raw, err := hex.DecodeString(first)
	if err != nil || len(raw) != 16 {
		t.Fatalf("token %q is not 128-bit hex: bytes=%d err=%v", first, len(raw), err)
	}
}

func TestRequireAflClaimUpdate(t *testing.T) {
	if err := requireAflClaimUpdate(1, nil); err != nil {
		t.Fatalf("one updated row should succeed: %v", err)
	}
	for _, rows := range []int64{0, 2} {
		if err := requireAflClaimUpdate(rows, nil); !errors.Is(err, ErrAflAnnouncementClaimLost) {
			t.Errorf("rows=%d: got %v, want ErrAflAnnouncementClaimLost", rows, err)
		}
	}
	dbErr := errors.New("rows unavailable")
	if err := requireAflClaimUpdate(0, dbErr); !errors.Is(err, dbErr) {
		t.Errorf("rows error = %v, want wrapped %v", err, dbErr)
	}
}

func TestTruncateRunesPreservesUTF8(t *testing.T) {
	got := truncateRunes("🏉bounce soon", 3)
	if got != "🏉bo" {
		t.Errorf("truncateRunes = %q, want %q", got, "🏉bo")
	}
}

func TestAflAnnouncementDeliveryMigration(t *testing.T) {
	body, err := fs.ReadFile(database.Migrations, "migrations/023_create_afl_announcement_deliveries.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(body)
	for _, fragment := range []string{
		"CREATE TABLE IF NOT EXISTS AflAnnouncementDeliveries",
		"PRIMARY KEY (guildId, announcementKind, gameId, kickoffUnix)",
		"claimToken CHAR(32)",
		"sentAt DATETIME",
		"lastError VARCHAR(512)",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration missing %q", fragment)
		}
	}
}
