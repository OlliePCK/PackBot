package storage

import (
	"encoding/hex"
	"errors"
	"io/fs"
	"strings"
	"testing"

	"github.com/OlliePCK/packbot/database"
)

func TestValidateYouTubeNotificationKey(t *testing.T) {
	valid := YouTubeNotificationKey{
		GuildID: "guild", NotifyChannelID: "discord-channel",
		YouTubeChannelID: "youtube-channel", VideoID: "video",
	}
	if err := validateYouTubeNotificationKey(valid); err != nil {
		t.Fatalf("valid key rejected: %v", err)
	}
	for _, key := range []YouTubeNotificationKey{
		{},
		{GuildID: "guild", YouTubeChannelID: "youtube", VideoID: "video"},
		{GuildID: "guild", NotifyChannelID: "discord", VideoID: "video"},
		{GuildID: "guild", NotifyChannelID: "discord", YouTubeChannelID: "youtube"},
	} {
		if err := validateYouTubeNotificationKey(key); err == nil {
			t.Errorf("invalid key accepted: %+v", key)
		}
	}
}

func TestYouTubeClaimToken(t *testing.T) {
	first, err := youtubeClaimToken()
	if err != nil {
		t.Fatalf("first token: %v", err)
	}
	second, err := youtubeClaimToken()
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

func TestRequireYouTubeClaimUpdate(t *testing.T) {
	if err := requireYouTubeClaimUpdate(1, nil); err != nil {
		t.Fatalf("one updated row should succeed: %v", err)
	}
	for _, rows := range []int64{0, 2} {
		if err := requireYouTubeClaimUpdate(rows, nil); !errors.Is(err, ErrYouTubeNotificationClaimLost) {
			t.Errorf("rows=%d: got %v, want ErrYouTubeNotificationClaimLost", rows, err)
		}
	}
}

func TestYouTubeNotificationMigration(t *testing.T) {
	body, err := fs.ReadFile(database.Migrations, "migrations/029_repair_youtube_notifications.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(body)
	for _, fragment := range []string{
		"ADD COLUMN IF NOT EXISTS createdAt",
		"CREATE TABLE IF NOT EXISTS YoutubeNotificationDeliveries",
		"PRIMARY KEY (notifyChannelId, youtubeChannelId, videoId)",
		"claimToken CHAR(32)",
		"sentAt DATETIME",
		"skippedAt DATETIME",
		"discordMessageId VARCHAR(32)",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration missing %q", fragment)
		}
	}
}
