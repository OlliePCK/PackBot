// Package commands defines PackBot's slash commands.
//
// Each command pairs its Discord definition with a handler. The bot package
// owns dispatch: it defers the interaction response first (mirroring the Node
// bot's interactionCreate), then calls Run, which edits the deferred reply.
package commands

import (
	"context"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/music"
	"github.com/OlliePCK/packbot/internal/storage"
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
	}
}

// Respond edits the deferred reply with one or more embeds — the standard way
// every PackBot command answers (Node: interaction.editReply({embeds: [...]})).
func Respond(s *discordgo.Session, i *discordgo.InteractionCreate, embeds ...*discordgo.MessageEmbed) error {
	_, err := s.InteractionResponseEdit(i.Interaction, &discordgo.WebhookEdit{
		Embeds: &embeds,
	})
	return err
}

// RespondComplex edits the deferred reply with embeds and components.
func RespondComplex(s *discordgo.Session, i *discordgo.InteractionCreate, embeds []*discordgo.MessageEmbed, components []discordgo.MessageComponent) (*discordgo.Message, error) {
	return s.InteractionResponseEdit(i.Interaction, &discordgo.WebhookEdit{
		Embeds:     &embeds,
		Components: &components,
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
