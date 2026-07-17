// Package bot owns the Discord session: gateway connection, intents,
// slash-command registration and interaction dispatch.
package bot

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/commands"
	"github.com/OlliePCK/packbot/internal/config"
	"github.com/OlliePCK/packbot/internal/style"
	"github.com/OlliePCK/packbot/internal/trackers"
)

// Bot wraps the discordgo session and the command registry.
type Bot struct {
	cfg      *config.Config
	session  *discordgo.Session
	commands map[string]*commands.Command

	// componentRoutes maps customID prefixes to their owning command handler.
	componentRoutes map[string]commands.Handler
}

// New wires handlers onto the provided session; it does not connect yet.
// The session is created by the caller so other components (music, API,
// jobs) can share it.
func New(cfg *config.Config, session *discordgo.Session, deps commands.Deps) (*Bot, error) {
	// Intent notes vs the Node bot: GuildMessages and GuildMessageReactions
	// are gone with starboard/quotes. Presences and Members are privileged —
	// their toggles must be enabled in the Discord developer portal.
	session.Identify.Intents = discordgo.IntentsGuilds |
		discordgo.IntentsGuildPresences |
		discordgo.IntentsGuildMembers |
		discordgo.IntentsGuildVoiceStates

	registry := make(map[string]*commands.Command)
	componentRoutes := make(map[string]commands.Handler)
	for _, cmd := range commands.All(deps) {
		registry[cmd.Def.Name] = cmd
		for prefix, handler := range cmd.Components {
			componentRoutes[prefix] = handler
		}
	}

	b := &Bot{cfg: cfg, session: session, commands: registry, componentRoutes: componentRoutes}
	session.AddHandler(b.onReady)
	session.AddHandler(b.onInteractionCreate)

	// Presence-driven trackers (Node: events/event-functions/).
	gameExpose := trackers.NewGameExpose(deps.Store)
	session.AddHandler(gameExpose.HandlePresenceUpdate)
	liveNoti := trackers.NewLiveNoti(deps.Store)
	session.AddHandler(liveNoti.HandlePresenceUpdate)
	session.AddHandler(liveNoti.HandleVoiceStateUpdate)

	return b, nil
}

// Session exposes the underlying discordgo session (used by background jobs).
func (b *Bot) Session() *discordgo.Session {
	return b.session
}

// Run connects, optionally registers commands, and blocks until ctx is
// cancelled (SIGTERM/SIGINT), then closes the gateway connection cleanly.
func (b *Bot) Run(ctx context.Context) error {
	if err := b.session.Open(); err != nil {
		return fmt.Errorf("bot: open gateway: %w", err)
	}
	slog.Info("gateway connected")

	if b.cfg.RegisterCommands {
		if err := b.registerCommands(); err != nil {
			b.session.Close()
			return err
		}
	}

	<-ctx.Done()
	slog.Info("shutdown signal received, closing gateway")
	if err := b.session.Close(); err != nil {
		return fmt.Errorf("bot: close gateway: %w", err)
	}
	slog.Info("gateway closed")
	return nil
}

// registerCommands bulk-overwrites the application's commands. Scoped to
// DEV_GUILD_ID when set (instant propagation; safe for a dev application),
// global otherwise. NOTE: a global overwrite REPLACES all existing global
// commands for this application — never point this at the live Node bot's
// application until cutover. Register only after the bot has joined the
// guild: registering earlier gets wiped by the OAuth authorization.
func (b *Bot) registerCommands() error {
	defs := make([]*discordgo.ApplicationCommand, 0, len(b.commands))
	for _, cmd := range b.commands {
		defs = append(defs, cmd.Def)
	}

	scope := "global"
	if b.cfg.DevGuildID != "" {
		scope = "guild " + b.cfg.DevGuildID
	}
	created, err := b.session.ApplicationCommandBulkOverwrite(b.cfg.ClientID, b.cfg.DevGuildID, defs)
	if err != nil {
		return fmt.Errorf("bot: register commands (%s): %w", scope, err)
	}
	if len(created) != len(defs) {
		return fmt.Errorf("bot: register commands (%s): sent %d, Discord confirmed %d", scope, len(defs), len(created))
	}
	slog.Info("slash commands registered", "confirmed", len(created), "scope", scope)
	return nil
}

func (b *Bot) onReady(s *discordgo.Session, r *discordgo.Ready) {
	slog.Info("ready", "user", r.User.Username, "guilds", len(r.Guilds))

	// Presence parity with the Node bot.
	if err := s.UpdateGameStatus(0, "thepck.com"); err != nil {
		slog.Error("failed to set presence", "error", err)
	}
}

func (b *Bot) onInteractionCreate(s *discordgo.Session, i *discordgo.InteractionCreate) {
	switch i.Type {
	case discordgo.InteractionApplicationCommand:
		b.handleCommand(s, i)
	case discordgo.InteractionApplicationCommandAutocomplete:
		b.handleAutocomplete(s, i)
	case discordgo.InteractionMessageComponent:
		b.handleComponent(s, i)
	}
}

// handleCommand mirrors the Node bot's interactionCreate: defer the reply
// immediately (ephemeral where the command asks for it), then run the
// handler, which edits the deferred reply.
func (b *Bot) handleCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	data := i.ApplicationCommandData()
	cmd, ok := b.commands[data.Name]
	if !ok {
		return
	}

	var flags discordgo.MessageFlags
	if cmd.Ephemeral {
		flags = discordgo.MessageFlagsEphemeral
	}
	err := s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseDeferredChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{Flags: flags},
	})
	if err != nil {
		slog.Error("failed to defer interaction", "command", data.Name, "error", err)
		return
	}

	slog.Info("command", "name", "/"+data.Name, "user", interactionUserTag(i), "guild", i.GuildID)

	if err := cmd.Run(context.Background(), s, i); err != nil {
		slog.Error("command failed", "command", data.Name, "error", err)
		if editErr := commands.Respond(s, i, style.ErrorEmbed("There was an error while executing this command.")); editErr != nil {
			slog.Error("failed to send error reply", "command", data.Name, "error", editErr)
		}
	}
}

// handleAutocomplete answers option autocomplete; errors degrade to an empty
// choice list (parity with Node's catch → respond([])).
func (b *Bot) handleAutocomplete(s *discordgo.Session, i *discordgo.InteractionCreate) {
	data := i.ApplicationCommandData()
	cmd, ok := b.commands[data.Name]
	if !ok || cmd.Autocomplete == nil {
		return
	}

	choices, err := cmd.Autocomplete(context.Background(), s, i)
	if err != nil {
		slog.Error("autocomplete failed", "command", data.Name, "error", err)
		choices = nil
	}
	if choices == nil {
		choices = []*discordgo.ApplicationCommandOptionChoice{}
	}

	err = s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionApplicationCommandAutocompleteResult,
		Data: &discordgo.InteractionResponseData{Choices: choices},
	})
	if err != nil {
		slog.Error("failed to send autocomplete choices", "command", data.Name, "error", err)
	}
}

// handleComponent routes message-component interactions (buttons, selects)
// by customID prefix. Handlers respond directly — no automatic defer.
func (b *Bot) handleComponent(s *discordgo.Session, i *discordgo.InteractionCreate) {
	customID := i.MessageComponentData().CustomID
	for prefix, handler := range b.componentRoutes {
		if strings.HasPrefix(customID, prefix) {
			if err := handler(context.Background(), s, i); err != nil {
				slog.Error("component handler failed", "customID", customID, "error", err)
			}
			return
		}
	}
}

func interactionUserTag(i *discordgo.InteractionCreate) string {
	if i.Member != nil && i.Member.User != nil {
		return i.Member.User.Username
	}
	if i.User != nil {
		return i.User.Username
	}
	return "unknown"
}
