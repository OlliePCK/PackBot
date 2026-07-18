package storage

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strconv"
	"time"

	"github.com/OlliePCK/packbot/database"
)

// migrationsBaseline is the highest migration number that predates the Go
// runner. Production carries 001–020 (applied by Node's migrate.js or by
// hand) with no tracking table, so on first run against an existing database
// those are recorded as applied without executing; anything newer runs.
const migrationsBaseline = 20

// Migrate applies pending SQL migrations from database/migrations at
// startup. It opens its own connection because migration files contain many
// statements per file (multiStatements stays off the main pool on purpose —
// it makes SQL injection bugs far more damaging).
func (s *Store) Migrate(ctx context.Context) error {
	names, err := migrationNames(database.Migrations)
	if err != nil {
		return fmt.Errorf("storage: list migrations: %w", err)
	}

	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&charset=utf8mb4,utf8&loc=Local&multiStatements=true",
		s.cfg.User, s.cfg.Password, s.cfg.Host, s.cfg.Port, s.cfg.DB)
	mdb, err := sql.Open("mysql", dsn)
	if err != nil {
		return fmt.Errorf("storage: open migration connection: %w", err)
	}
	defer mdb.Close()

	if _, err := mdb.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS SchemaMigrations (
		version VARCHAR(255) NOT NULL PRIMARY KEY,
		appliedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
		return fmt.Errorf("storage: create SchemaMigrations: %w", err)
	}

	applied := make(map[string]bool)
	rows, err := mdb.QueryContext(ctx, `SELECT version FROM SchemaMigrations`)
	if err != nil {
		return fmt.Errorf("storage: read applied migrations: %w", err)
	}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return fmt.Errorf("storage: scan migration version: %w", err)
		}
		applied[v] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	// Baseline an existing pre-runner database: nothing recorded yet, but the
	// schema is clearly present.
	if len(applied) == 0 {
		var exists int
		err := mdb.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.tables
			WHERE table_schema = DATABASE() AND table_name = 'Guilds'`).Scan(&exists)
		if err != nil {
			return fmt.Errorf("storage: check for existing schema: %w", err)
		}
		if exists > 0 {
			for _, name := range baselineVersions(names, migrationsBaseline) {
				if _, err := mdb.ExecContext(ctx,
					`INSERT INTO SchemaMigrations (version) VALUES (?)`, name); err != nil {
					return fmt.Errorf("storage: record baseline %s: %w", name, err)
				}
				applied[name] = true
			}
			slog.Info("migrations baselined for existing schema", "through", migrationsBaseline)
		}
	}

	ran := 0
	for _, name := range names {
		if applied[name] {
			continue
		}
		body, err := fs.ReadFile(database.Migrations, "migrations/"+name)
		if err != nil {
			return fmt.Errorf("storage: read migration %s: %w", name, err)
		}
		start := time.Now()
		if _, err := mdb.ExecContext(ctx, string(body)); err != nil {
			return fmt.Errorf("storage: apply migration %s: %w", name, err)
		}
		if _, err := mdb.ExecContext(ctx,
			`INSERT INTO SchemaMigrations (version) VALUES (?)`, name); err != nil {
			return fmt.Errorf("storage: record migration %s: %w", name, err)
		}
		slog.Info("migration applied", "version", name, "took", time.Since(start).Round(time.Millisecond))
		ran++
	}
	if ran == 0 {
		slog.Info("database schema up to date", "migrations", len(names))
	}
	return nil
}

// migrationNames returns the embedded migration filenames in apply order.
func migrationNames(fsys fs.FS) ([]string, error) {
	entries, err := fs.ReadDir(fsys, "migrations")
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

// baselineVersions filters names to those at or below the numeric baseline.
func baselineVersions(names []string, through int) []string {
	var out []string
	for _, name := range names {
		if len(name) < 3 {
			continue
		}
		n, err := strconv.Atoi(name[:3])
		if err == nil && n <= through {
			out = append(out, name)
		}
	}
	return out
}
