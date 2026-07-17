package commands

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
)

var playlistNameRe = regexp.MustCompile(`^[a-z0-9_-]+$`)

// detectPlatform mirrors the Node URL sniffing for the platform emoji.
func detectPlatform(url string) string {
	switch {
	case strings.Contains(url, "spotify.com"):
		return "spotify"
	case strings.Contains(url, "youtube.com"), strings.Contains(url, "youtu.be"):
		return "youtube"
	case strings.Contains(url, "soundcloud.com"):
		return "soundcloud"
	default:
		return "other"
	}
}

func platformEmoji(platform string) string {
	switch platform {
	case "spotify":
		return "🟢"
	case "youtube":
		return "🔴"
	case "soundcloud":
		return "🟠"
	default:
		return "🔗"
	}
}

// Playlist is /playlist — per-user saved playlists.
//
// NOTE: the `play` subcommand needs the music system; until the music batch
// lands it responds with a friendly not-yet message.
func Playlist(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "playlist",
			Description: "Save and manage your favorite playlists",
			Options: []*discordgo.ApplicationCommandOption{
				{
					Type: discordgo.ApplicationCommandOptionSubCommand, Name: "save",
					Description: "Save a playlist for quick access",
					Options: []*discordgo.ApplicationCommandOption{
						{Type: discordgo.ApplicationCommandOptionString, Name: "name", Description: `A short name for this playlist (e.g., "chill", "workout")`, Required: true, MaxLength: 50},
						{Type: discordgo.ApplicationCommandOptionString, Name: "url", Description: "The playlist URL (Spotify, YouTube, SoundCloud)", Required: true},
					},
				},
				{
					Type: discordgo.ApplicationCommandOptionSubCommand, Name: "play",
					Description: "Play one of your saved playlists",
					Options: []*discordgo.ApplicationCommandOption{
						{Type: discordgo.ApplicationCommandOptionString, Name: "name", Description: "Name of the saved playlist", Required: true, Autocomplete: true},
					},
				},
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "list", Description: "List all your saved playlists"},
				{
					Type: discordgo.ApplicationCommandOptionSubCommand, Name: "remove",
					Description: "Remove a saved playlist",
					Options: []*discordgo.ApplicationCommandOption{
						{Type: discordgo.ApplicationCommandOptionString, Name: "name", Description: "Name of the playlist to remove", Required: true, Autocomplete: true},
					},
				},
			},
		},
		Autocomplete: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) ([]*discordgo.ApplicationCommandOptionChoice, error) {
			_, opts := subcommand(i)
			var focused string
			for _, o := range opts {
				if o.Focused {
					focused = strings.ToLower(o.StringValue())
				}
			}
			user := interactionUser(i)
			playlists, err := d.Store.ListPlaylists(ctx, i.GuildID, user.ID)
			if err != nil {
				return nil, err
			}
			var choices []*discordgo.ApplicationCommandOptionChoice
			for _, p := range playlists {
				if focused != "" && !strings.Contains(strings.ToLower(p.Name), focused) {
					continue
				}
				choices = append(choices, &discordgo.ApplicationCommandOptionChoice{
					Name:  platformEmoji(p.Platform) + " " + p.Name,
					Value: p.Name,
				})
				if len(choices) == 25 {
					break
				}
			}
			return choices, nil
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			sub, opts := subcommand(i)
			om := optionMap(opts)
			user := interactionUser(i)

			switch sub {
			case "save":
				name := strings.TrimSpace(strings.ToLower(om["name"].StringValue()))
				url := strings.TrimSpace(om["url"].StringValue())

				if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
					return Respond(s, i, style.ErrorEmbed("Please provide a valid URL."))
				}
				if !playlistNameRe.MatchString(name) {
					return Respond(s, i, style.ErrorEmbed("Playlist name can only contain letters, numbers, dashes, and underscores."))
				}

				platform := detectPlatform(url)
				err := d.Store.SavePlaylist(ctx, i.GuildID, user.ID, name, url, platform)
				if errors.Is(err, storage.ErrPlaylistLimit) {
					return Respond(s, i, style.ErrorEmbed(fmt.Sprintf("You've reached the maximum of %d saved playlists. Remove one first.", storage.MaxSavedPlaylists)))
				}
				if err != nil {
					return err
				}

				embed := &discordgo.MessageEmbed{
					Title:       style.Emotes.Success + " | Playlist Saved!",
					Description: fmt.Sprintf("You can now play this playlist anytime with:\n`/playlist play %s`", name),
					Color:       style.ColorSuccess,
					Footer:      style.Footer(),
					Fields: []*discordgo.MessageEmbedField{
						{Name: "Name", Value: "`" + name + "`", Inline: true},
						{Name: "Platform", Value: platformEmoji(platform) + " " + platform, Inline: true},
					},
				}
				return Respond(s, i, embed)

			case "play":
				name := strings.TrimSpace(strings.ToLower(om["name"].StringValue()))
				playlist, err := d.Store.GetPlaylist(ctx, i.GuildID, user.ID, name)
				if err != nil {
					return err
				}
				if playlist == nil {
					return Respond(s, i, style.ErrorEmbed(fmt.Sprintf("No playlist found with name `%s`.\nUse `/playlist list` to see your saved playlists.", name)))
				}
				if !requireMusic(d, s, i) {
					return nil
				}
				voiceChannel := requireVoice(s, i)
				if voiceChannel == "" {
					return nil
				}
				return playQuery(ctx, d, s, i, playlist.URL, voiceChannel, user)

			case "list":
				playlists, err := d.Store.ListPlaylists(ctx, i.GuildID, user.ID)
				if err != nil {
					return err
				}
				if len(playlists) == 0 {
					embed := &discordgo.MessageEmbed{
						Title:       "📋 Your Saved Playlists",
						Description: "You don't have any saved playlists yet.\n\nSave one with:\n`/playlist save <name> <url>`",
						Color:       style.ColorBrand,
						Footer:      style.Footer(),
					}
					return Respond(s, i, embed)
				}
				var lines []string
				for _, p := range playlists {
					lines = append(lines, fmt.Sprintf("%s **%s** - [Link](%s)", platformEmoji(p.Platform), p.Name, p.URL))
				}
				embed := &discordgo.MessageEmbed{
					Title:       fmt.Sprintf("📋 Your Saved Playlists (%d/%d)", len(playlists), storage.MaxSavedPlaylists),
					Description: strings.Join(lines, "\n"),
					Color:       style.ColorBrand,
					Footer:      &discordgo.MessageEmbedFooter{Text: "The Pack • Use /playlist play <name> to play", IconURL: style.LogoURL},
				}
				return Respond(s, i, embed)

			case "remove":
				name := strings.TrimSpace(strings.ToLower(om["name"].StringValue()))
				removed, err := d.Store.DeletePlaylist(ctx, i.GuildID, user.ID, name)
				if err != nil {
					return err
				}
				if !removed {
					return Respond(s, i, style.ErrorEmbed(fmt.Sprintf("No playlist found with name `%s`.", name)))
				}
				embed := &discordgo.MessageEmbed{
					Description: fmt.Sprintf("%s | Playlist `%s` has been removed.", style.Emotes.Success, name),
					Color:       style.ColorSuccess,
					Footer:      style.Footer(),
				}
				return Respond(s, i, embed)
			}
			return fmt.Errorf("unknown playlist subcommand %q", sub)
		},
	}
}
