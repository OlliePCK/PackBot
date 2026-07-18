// PackBot — Go rewrite of the Node.js Discord bot.
// Feature-parity contract: FEATURES.md at the repo root.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/afl"
	"github.com/OlliePCK/packbot/internal/api"
	"github.com/OlliePCK/packbot/internal/bot"
	"github.com/OlliePCK/packbot/internal/commands"
	"github.com/OlliePCK/packbot/internal/config"
	"github.com/OlliePCK/packbot/internal/jobs"
	"github.com/OlliePCK/packbot/internal/logging"
	"github.com/OlliePCK/packbot/internal/music"
	"github.com/OlliePCK/packbot/internal/spotify"
	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/youtube"
)

func main() {
	if err := run(); err != nil {
		// Config/startup errors may occur before slog is configured; write
		// plainly to stderr and exit non-zero so Docker restarts the container.
		fmt.Fprintln(os.Stderr, "packbot:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	logging.Setup(cfg.Log)

	// NotifyContext cancels ctx on SIGTERM (Docker stop) or SIGINT (Ctrl-C),
	// which unblocks Bot.Run for a clean gateway close.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	store, err := storage.Open(cfg.MySQL)
	if err != nil {
		return err
	}
	defer store.Close()

	// Schema migrations apply at startup (embedded SQL, tracked in
	// SchemaMigrations). Failing fast beats running on a half-migrated schema.
	if err := store.Migrate(ctx); err != nil {
		return err
	}

	// The discordgo session is created here so it can be injected into both
	// the music manager and the bot (explicit dependency wiring).
	session, err := discordgo.New("Bot " + cfg.Token)
	if err != nil {
		return fmt.Errorf("create discord session: %w", err)
	}

	// YouTube Data API client is optional: without a key, /youtube degrades
	// gracefully and the notifications job doesn't start.
	var yt *youtube.Client
	if cfg.YouTubeAPIKey != "" {
		yt, err = youtube.New(cfg.YouTubeAPIKey, cfg.ProxyURL)
		if err != nil {
			return err
		}
	} else {
		slog.Warn("YOUTUBE_API_KEY not set; /youtube and upload notifications disabled")
	}

	deps := commands.Deps{Store: store, YouTube: yt, AdminUserID: cfg.API.AdminUserID}
	var musicManager *music.Manager

	// AFL predictions: reads the model dashboard on grid; disabled without a URL.
	if cfg.AFLAPIURL != "" {
		aflService := afl.New(cfg.AFLAPIURL, store)
		deps.AFL = aflService
		go func() {
			if err := aflService.SyncEmojis(session, cfg.ClientID); err != nil {
				slog.Error("AFL club emoji sync failed; cards render without logos", "error", err)
			}
		}()
		go aflService.Run(ctx, session)
	} else {
		slog.Warn("AFL_API_URL not set; /tips and AFL announcements disabled")
	}

	// Music runs against a Lavalink node; the node being down disables music
	// but leaves the rest of the bot up. The bot's user ID comes from a REST
	// self-lookup since the gateway isn't open yet.
	if cfg.LavalinkAddress != "" {
		self, err := session.User("@me")
		if err != nil {
			return fmt.Errorf("fetch bot user: %w", err)
		}
		var sp *spotify.Client
		if cfg.SpotifyClientID != "" && cfg.SpotifyClientSecret != "" {
			sp = spotify.New(cfg.SpotifyClientID, cfg.SpotifyClientSecret)
		} else {
			slog.Warn("SPOTIFY_CLIENT_ID/SECRET not set; Spotify links disabled")
		}
		manager, err := music.NewManager(ctx, session, store, sp, yt, self.ID, cfg.LavalinkAddress, cfg.LavalinkPassword, cfg.API.AdminUserID)
		if err != nil {
			slog.Error("lavalink unavailable; music disabled", "error", err)
		} else {
			deps.Music = manager
			musicManager = manager
		}
	} else {
		slog.Warn("LAVALINK_ADDRESS not set; music disabled")
	}

	b, err := bot.New(cfg, session, deps)
	if err != nil {
		return err
	}

	// Background jobs run until ctx is cancelled; they only use REST calls,
	// so they don't need to wait for the gateway to be ready.
	go jobs.PollExpiry(ctx, session, store)
	go jobs.BirthdayReminders(ctx, session, store)
	if yt != nil {
		go jobs.YouTubeNotifications(ctx, session, store, yt, cfg.YTMaxBackoffMultiplier)
	}

	// Web API (Node started it on clientReady; here it runs alongside the
	// gateway and shuts down on the same signal context).
	if cfg.API.Enabled {
		apiServer := api.New(cfg.API, store, session, yt, musicManager)
		go func() {
			if err := apiServer.Run(ctx); err != nil {
				slog.Error("web API server failed", "error", err)
			}
		}()
	}

	return b.Run(ctx)
}
