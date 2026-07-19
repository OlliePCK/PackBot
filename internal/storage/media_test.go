package storage

import (
	"errors"
	"io/fs"
	"strings"
	"testing"

	"github.com/OlliePCK/packbot/database"
)

func TestValidateMediaCardIdentity(t *testing.T) {
	if err := validateMediaCardIdentity(
		"773732791585865769",
		"57f44ef3ee6b38a4bea6a9fd001d1aec",
		"773732792051040268",
	); err != nil {
		t.Fatalf("valid identity rejected: %v", err)
	}

	tests := []struct {
		name      string
		guildID   string
		channelID string
		discordID string
	}{
		{"missing guild", "", "57f44ef3ee6b38a4bea6a9fd001d1aec", "773732792051040268"},
		{"non-numeric guild", "guild", "57f44ef3ee6b38a4bea6a9fd001d1aec", "773732792051040268"},
		{"missing Jellyfin channel", "773732791585865769", "", "773732792051040268"},
		{"unsafe Jellyfin channel", "773732791585865769", "channel?token=secret", "773732792051040268"},
		{"non-numeric Discord channel", "773732791585865769", "57f44ef3ee6b38a4bea6a9fd001d1aec", "general"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateMediaCardIdentity(tt.guildID, tt.channelID, tt.discordID); err == nil {
				t.Fatal("invalid identity was accepted")
			}
		})
	}
}

func TestRequireSingleMediaUpdate(t *testing.T) {
	if err := requireSingleMediaUpdate(1, "activate", nil); err != nil {
		t.Fatalf("one updated row should succeed: %v", err)
	}
	for _, rows := range []int64{0, 2} {
		if err := requireSingleMediaUpdate(rows, "activate", nil); err == nil {
			t.Errorf("rows=%d: expected state error", rows)
		}
	}
	dbErr := errors.New("rows unavailable")
	if err := requireSingleMediaUpdate(0, "activate", dbErr); !errors.Is(err, dbErr) {
		t.Errorf("rows error = %v, want wrapped %v", err, dbErr)
	}
}

func TestMediaLiveCardMigration(t *testing.T) {
	body, err := fs.ReadFile(database.Migrations, "migrations/024_create_media_live_cards.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(body)
	for _, fragment := range []string{
		"CREATE TABLE IF NOT EXISTS MediaLiveCards",
		"PRIMARY KEY (guildId, jellyfinChannelId)",
		"discordMessageId VARCHAR(32)",
		"ENUM('pending', 'active')",
		"idx_media_live_cards_status",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration missing %q", fragment)
		}
	}
}
