// Package logging configures the process-wide slog default logger.
//
// Deviation from the Node bot (deliberate, 12-factor): logs go to stdout only.
// The Node logger's file rotation (LOG_DIR/LOG_MAX_SIZE_MB/LOG_MAX_FILES) is
// dropped — Docker/Unraid already capture and rotate container stdout.
package logging

import (
	"log/slog"
	"os"

	"github.com/OlliePCK/packbot/internal/config"
)

// Setup installs the default slog logger according to config.
func Setup(cfg config.Log) {
	opts := &slog.HandlerOptions{Level: cfg.Level}

	var handler slog.Handler
	if cfg.Format == "json" {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	} else {
		handler = slog.NewTextHandler(os.Stdout, opts)
	}

	slog.SetDefault(slog.New(handler))
}
