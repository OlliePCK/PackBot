// Package storage is PackBot's MySQL persistence layer.
//
// It uses database/sql with the go-sql-driver/mysql driver — the one
// dependency beyond discordgo, justified because the standard library defines
// the SQL interface but ships no MySQL driver. All queries are parameterized;
// pool sizing mirrors the Node bot's mysql2 pool (10 connections, 60s idle).
package storage

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/go-sql-driver/mysql" // registers the "mysql" driver

	"github.com/OlliePCK/packbot/internal/config"
)

// Store wraps the connection pool and all repository methods.
type Store struct {
	db *sql.DB

	guildCache guildCache
}

// Open connects to MySQL and verifies the connection.
func Open(cfg config.MySQL) (*Store, error) {
	// parseTime maps DATETIME/TIMESTAMP columns to time.Time.
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&charset=utf8mb4,utf8&loc=Local",
		cfg.User, cfg.Password, cfg.Host, cfg.Port, cfg.DB)

	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("storage: open: %w", err)
	}

	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(10)
	db.SetConnMaxIdleTime(60 * time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("storage: ping %s:%s/%s: %w", cfg.Host, cfg.Port, cfg.DB, err)
	}

	return &Store{db: db, guildCache: newGuildCache()}, nil
}

// Close releases the connection pool.
func (s *Store) Close() error {
	return s.db.Close()
}
