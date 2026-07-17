package commands

import (
	"context"
	"fmt"
	"strings"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/music"
	"github.com/OlliePCK/packbot/internal/style"
)

// Filters is /filters — live audio filters on Lavalink's filter engine.
// No playback restart needed (the Node version rebuilt its FFmpeg pipeline
// per change); filters apply to the running stream within a second or two.
func Filters(d Deps) *Command {
	choices := make([]*discordgo.ApplicationCommandOptionChoice, 0)
	for _, def := range music.FilterChoices() {
		choices = append(choices, &discordgo.ApplicationCommandOptionChoice{Name: def.Name, Value: def.Key})
	}
	filterOption := func() *discordgo.ApplicationCommandOption {
		return &discordgo.ApplicationCommandOption{
			Type: discordgo.ApplicationCommandOptionString, Name: "filter",
			Description: "The filter", Required: true, Choices: choices,
		}
	}

	activeList := func(guildID string) string {
		active := d.Music.ActiveFilters(guildID)
		if len(active) == 0 {
			return "None"
		}
		names := make([]string, len(active))
		for idx, key := range active {
			names[idx] = music.FilterName(key)
		}
		return strings.Join(names, ", ")
	}

	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "filters",
			Description: "Apply audio filters to the music.",
			Options: []*discordgo.ApplicationCommandOption{
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "add", Description: "Add a filter to the current playback.", Options: []*discordgo.ApplicationCommandOption{filterOption()}},
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "remove", Description: "Remove a filter from the current playback.", Options: []*discordgo.ApplicationCommandOption{filterOption()}},
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "clear", Description: "Clear all active filters."},
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "list", Description: "Show all active filters."},
			},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			// No is-playing gate (unlike Node): filter state persists on the
			// guild session, so it must be manageable while idle too —
			// live testing hit un-clearable filters after /stop otherwise.

			sub, opts := subcommand(i)
			om := optionMap(opts)

			switch sub {
			case "add":
				key := om["filter"].StringValue()
				if _, err := d.Music.AddFilter(ctx, i.GuildID, key); err != nil {
					return Respond(s, i, style.ErrorEmbed(err.Error()))
				}
				embed := &discordgo.MessageEmbed{
					Title:       style.Emotes.Success + " | Filter Added",
					Description: fmt.Sprintf("🎛️ **%s** has been applied.", music.FilterName(key)),
					Color:       style.ColorBrand,
					Footer:      style.Footer(),
					Fields: []*discordgo.MessageEmbedField{
						{Name: "Active Filters", Value: activeList(i.GuildID), Inline: true},
						{Name: "Requested by", Value: interactionUser(i).Mention(), Inline: true},
					},
				}
				return Respond(s, i, embed)

			case "remove":
				key := om["filter"].StringValue()
				if _, err := d.Music.RemoveFilter(ctx, i.GuildID, key); err != nil {
					return Respond(s, i, style.ErrorEmbed(err.Error()))
				}
				embed := &discordgo.MessageEmbed{
					Description: fmt.Sprintf("🎛️ **%s** filter removed.", music.FilterName(key)),
					Color:       style.ColorSuccess,
					Footer:      style.Footer(),
					Fields: []*discordgo.MessageEmbedField{
						{Name: "Active Filters", Value: activeList(i.GuildID), Inline: true},
					},
				}
				return Respond(s, i, embed)

			case "clear":
				n, err := d.Music.ClearFilters(ctx, i.GuildID)
				if err != nil {
					return err
				}
				if n == 0 {
					return Respond(s, i, style.ErrorEmbed("No active filters to clear."))
				}
				return Respond(s, i, simpleSuccess("🎛️ All filters cleared."))

			case "list":
				var names []string
				for _, def := range music.FilterChoices() {
					names = append(names, def.Name)
				}
				embed := &discordgo.MessageEmbed{
					Title:  "🎛️ Audio Filters",
					Color:  style.ColorBrand,
					Footer: style.Footer(),
					Fields: []*discordgo.MessageEmbedField{
						{Name: "Active Filters", Value: activeList(i.GuildID)},
						{Name: "Available Filters", Value: strings.Join(names, ", ")},
					},
				}
				return Respond(s, i, embed)
			}
			return fmt.Errorf("unknown filters subcommand %q", sub)
		},
	}
}
