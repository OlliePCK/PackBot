// Package commands defines PackBot's slash commands.
//
// Each command pairs its Discord definition with a handler. The bot package
// owns dispatch: it defers the interaction response first (mirroring the Node
// bot's interactionCreate), then calls Run, which edits the deferred reply.
package commands

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/music"
	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
	"github.com/OlliePCK/packbot/internal/youtube"
)

// Deps carries shared dependencies into command constructors — Go's plain
// answer to dependency injection: an explicit struct, no framework.
type Deps struct {
	Store *storage.Store
	// YouTube is nil when YOUTUBE_API_KEY is unset; commands that need it
	// degrade gracefully.
	YouTube *youtube.Client
	// Music is nil when the Lavalink node is unavailable.
	Music *music.Manager
	// AdminUserID (API_ADMIN_USER_ID) gates owner-only commands (/ytauth).
	AdminUserID string
}

// Handler processes a deferred slash-command interaction.
type Handler func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error

// Command is one slash command: its registration payload plus its handlers.
type Command struct {
	// Def is the application-command definition sent to Discord on registration.
	Def *discordgo.ApplicationCommand

	// Ephemeral marks commands whose deferred reply is only visible to the
	// invoker (Node: `isEphemeral: true` — /purge, /settings).
	Ephemeral bool

	// Run handles the interaction. The reply is already deferred; respond by
	// editing it (see Respond helper). Returned errors are shown to the user
	// as a generic error message and logged.
	Run Handler

	// Autocomplete, when set, answers autocomplete interactions for this
	// command's options. Not deferred — must respond directly.
	Autocomplete func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) ([]*discordgo.ApplicationCommandOptionChoice, error)

	// Components maps a message-component customID prefix (e.g. "poll_vote_")
	// to its handler. Component interactions are not deferred by the bot;
	// handlers respond directly (usually with an in-place message update).
	Components map[string]Handler
}

// All returns every command in the bot, in registration order.
// Ported commands are appended here batch by batch.
func All(d Deps) []*Command {
	return []*Command{
		Ping(),
		Settings(d),
		Birthday(d),
		Leaderboard(d),
		Wrapped(d),
		Playlist(d),
		Poll(d),
		Purge(),
		YouTube(d),
		Play(d),
		StopMusic(d),
		Join(d),
		Leave(d),
		Skip(d),
		Pause(d),
		Volume(d),
		Seek(d),
		Repeat(d),
		Shuffle(d),
		Previous(d),
		Autoplay(d),
		Jump(d),
		Swap(d),
		Push(d),
		Undo(d),
		NowPlaying(d),
		Queue(d),
		Filters(d),
		YTAuth(d),
	}
}

// Respond edits the deferred reply — the standard way every PackBot command
// answers. Commands still build classic embeds; the reply is rendered as a
// Components-V2 card (style.FromEmbeds), falling back to a plain embed edit
// if Discord rejects the V2 payload so no command breaks on a rendering bug.
func Respond(s *discordgo.Session, i *discordgo.InteractionCreate, embeds ...*discordgo.MessageEmbed) error {
	if _, err := RespondV2(s, i, style.FromEmbeds(embeds...)); err == nil {
		return nil
	} else {
		slog.Warn("V2 reply rejected, falling back to embeds", "error", err)
	}
	_, err := s.InteractionResponseEdit(i.Interaction, &discordgo.WebhookEdit{
		Embeds: &embeds,
	})
	return err
}

// RespondComplex edits the deferred reply with embeds and interactive rows,
// rendered as one V2 card with the rows attached (same fallback as Respond).
func RespondComplex(s *discordgo.Session, i *discordgo.InteractionCreate, embeds []*discordgo.MessageEmbed, components []discordgo.MessageComponent) (*discordgo.Message, error) {
	if msg, err := RespondV2(s, i, style.FromEmbedsWithRows(embeds, components)); err == nil {
		return msg, nil
	} else {
		slog.Warn("V2 reply rejected, falling back to embeds", "error", err)
	}
	return s.InteractionResponseEdit(i.Interaction, &discordgo.WebhookEdit{
		Embeds:     &embeds,
		Components: &components,
	})
}

// RespondV2 edits the deferred reply into a Components-V2 message. discordgo
// v0.29's WebhookEdit has no Flags field, so this goes through the raw REST
// layer — IS_COMPONENTS_V2 may be applied on edit while the deferred message
// is still empty (no content/embeds).
func RespondV2(s *discordgo.Session, i *discordgo.InteractionCreate, components []discordgo.MessageComponent) (*discordgo.Message, error) {
	payload := struct {
		Components []discordgo.MessageComponent `json:"components"`
		Flags      discordgo.MessageFlags       `json:"flags"`
	}{components, discordgo.MessageFlagsIsComponentsV2}

	uri := discordgo.EndpointWebhookMessage(i.AppID, i.Token, "@original")
	body, err := s.RequestWithBucketID("PATCH", uri, payload, discordgo.EndpointWebhookToken("", ""))
	if err != nil {
		return nil, err
	}
	var msg discordgo.Message
	if err := json.Unmarshal(body, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

// UpdateV2 answers a component interaction by replacing the message's
// components (the message is already V2, so no flag change is needed); falls
// back to a legacy embed update for messages created before the V2 rollout.
func UpdateV2(s *discordgo.Session, i *discordgo.InteractionCreate, embeds []*discordgo.MessageEmbed, rows []discordgo.MessageComponent) error {
	err := s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseUpdateMessage,
		Data: &discordgo.InteractionResponseData{
			Components: style.FromEmbedsWithRows(embeds, rows),
		},
	})
	if err == nil {
		return nil
	}
	slog.Warn("V2 update rejected, falling back to embeds", "error", err)
	return s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseUpdateMessage,
		Data: &discordgo.InteractionResponseData{
			Embeds:     embeds,
			Components: rows,
		},
	})
}

// subcommand returns the invoked subcommand name and its options.
func subcommand(i *discordgo.InteractionCreate) (string, []*discordgo.ApplicationCommandInteractionDataOption) {
	opts := i.ApplicationCommandData().Options
	if len(opts) == 1 && opts[0].Type == discordgo.ApplicationCommandOptionSubCommand {
		return opts[0].Name, opts[0].Options
	}
	return "", opts
}

// optionMap indexes options by name for direct access.
func optionMap(opts []*discordgo.ApplicationCommandInteractionDataOption) map[string]*discordgo.ApplicationCommandInteractionDataOption {
	m := make(map[string]*discordgo.ApplicationCommandInteractionDataOption, len(opts))
	for _, o := range opts {
		m[o.Name] = o
	}
	return m
}

// interactionUser returns the invoking user (guild or DM interaction).
func interactionUser(i *discordgo.InteractionCreate) *discordgo.User {
	if i.Member != nil && i.Member.User != nil {
		return i.Member.User
	}
	return i.User
}

// displayName returns the best human-readable name for a user (parity with
// discord.js's user.displayName: global display name, else username).
func displayName(u *discordgo.User) string {
	if u == nil {
		return "Unknown"
	}
	if u.GlobalName != "" {
		return u.GlobalName
	}
	return u.Username
}
