package storage

import (
	"testing"

	"github.com/OlliePCK/packbot/database"
)

func TestMigrationNamesOrdered(t *testing.T) {
	names, err := migrationNames(database.Migrations)
	if err != nil {
		t.Fatalf("migrationNames: %v", err)
	}
	if len(names) < 22 {
		t.Fatalf("expected at least 22 migrations, got %d", len(names))
	}
	for i := 1; i < len(names); i++ {
		if names[i-1] >= names[i] {
			t.Errorf("names not strictly ordered: %s >= %s", names[i-1], names[i])
		}
	}
	if names[0] != "001_create_guilds_table.sql" {
		t.Errorf("first migration = %s", names[0])
	}
}

func TestBaselineVersions(t *testing.T) {
	names := []string{
		"001_create_guilds_table.sql",
		"019_fix_youtube_initialized.sql",
		"020_add_afl_settings.sql",
		"021_create_sessions.sql",
		"022_drop_dead_feature_tables.sql",
	}
	got := baselineVersions(names, migrationsBaseline)
	want := 3 // 001, 019, 020 — the pre-runner set; 021+ must actually run
	if len(got) != want {
		t.Fatalf("baseline covers %d files, want %d: %v", len(got), want, got)
	}
	for _, name := range got {
		if name >= "021" {
			t.Errorf("baseline wrongly includes %s", name)
		}
	}
}
