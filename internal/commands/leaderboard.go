package commands

import (
	"context"
	"fmt"
	"strings"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/style"
)

// Leaderboard is /leaderboard — playtime and music listening leaderboards.
func Leaderboard(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "leaderboard",
			Description: "View playtime leaderboards",
			Options: []*discordgo.ApplicationCommandOption{
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "total", Description: "Top 10 users by total playtime across all games"},
				{
					Type: discordgo.ApplicationCommandOptionSubCommand, Name: "game",
					Description: "Top 10 users for a specific game",
					Options: []*discordgo.ApplicationCommandOption{{
						Type: discordgo.ApplicationCommandOptionString, Name: "name",
						Description: "The game name to check", Required: true, Autocomplete: true,
					}},
				},
				{
					Type: discordgo.ApplicationCommandOptionSubCommand, Name: "user",
					Description: "View a user's playtime stats",
					Options: []*discordgo.ApplicationCommandOption{{
						Type: discordgo.ApplicationCommandOptionUser, Name: "member",
						Description: "The user to check (defaults to yourself)", Required: false,
					}},
				},
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "games", Description: "Top 10 most played games in this server"},
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "music", Description: "Top 10 music listeners by total listening time"},
			},
		},
		Autocomplete: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) ([]*discordgo.ApplicationCommandOptionChoice, error) {
			_, opts := subcommand(i)
			var focused string
			for _, o := range opts {
				if o.Focused {
					focused = o.StringValue()
				}
			}
			names, err := d.Store.SearchGameNames(ctx, i.GuildID, focused)
			if err != nil {
				return nil, err
			}
			choices := make([]*discordgo.ApplicationCommandOptionChoice, 0, len(names))
			for _, name := range names {
				if len(name) > 100 {
					name = name[:100]
				}
				choices = append(choices, &discordgo.ApplicationCommandOptionChoice{Name: name, Value: name})
			}
			return choices, nil
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			sub, opts := subcommand(i)
			om := optionMap(opts)

			switch sub {
			case "total":
				rows, err := d.Store.TopPlaytimeTotal(ctx, i.GuildID, 10)
				if err != nil {
					return err
				}
				if len(rows) == 0 {
					return Respond(s, i, style.BrandEmbed("📊 No playtime data recorded yet!"))
				}
				var lines []string
				for idx, r := range rows {
					lines = append(lines, fmt.Sprintf("%s <@%s> — %s", medal(idx), r.UserID, formatPlaytime(r.TotalSeconds)))
				}
				return Respond(s, i, leaderboardEmbed("🎮 Total Playtime Leaderboard", strings.Join(lines, "\n")))

			case "game":
				game := om["name"].StringValue()
				rows, err := d.Store.TopPlaytimeForGame(ctx, i.GuildID, game, 10)
				if err != nil {
					return err
				}
				if len(rows) == 0 {
					return Respond(s, i, style.BrandEmbed(fmt.Sprintf("📊 No playtime data for **%s** yet!", game)))
				}
				var lines []string
				for idx, r := range rows {
					lines = append(lines, fmt.Sprintf("%s <@%s> — %s", medal(idx), r.UserID, formatPlaytime(r.TotalSeconds)))
				}
				return Respond(s, i, leaderboardEmbed(fmt.Sprintf("🎮 %s Leaderboard", game), strings.Join(lines, "\n")))

			case "user":
				target := interactionUser(i)
				if opt, ok := om["member"]; ok {
					target = opt.UserValue(s)
				}
				rows, err := d.Store.UserPlaytime(ctx, i.GuildID, target.ID, 10)
				if err != nil {
					return err
				}
				if len(rows) == 0 {
					return Respond(s, i, style.BrandEmbed(fmt.Sprintf("📊 No playtime data for %s yet!", target.Username)))
				}
				var total int64
				var lines []string
				for idx, r := range rows {
					total += r.TotalSeconds
					lines = append(lines, fmt.Sprintf("**%d.** %s — %s", idx+1, r.GameName, formatPlaytime(r.TotalSeconds)))
				}
				embed := leaderboardEmbed(fmt.Sprintf("🎮 %s's Playtime", target.Username), "**Top Games:**\n"+strings.Join(lines, "\n"))
				embed.Thumbnail = &discordgo.MessageEmbedThumbnail{URL: target.AvatarURL("")}
				embed.Fields = []*discordgo.MessageEmbedField{
					{Name: "Total Playtime", Value: formatPlaytime(total), Inline: true},
					{Name: "Games Tracked", Value: fmt.Sprintf("%d", len(rows)), Inline: true},
				}
				return Respond(s, i, embed)

			case "games":
				rows, err := d.Store.TopGames(ctx, i.GuildID, 10)
				if err != nil {
					return err
				}
				if len(rows) == 0 {
					return Respond(s, i, style.BrandEmbed("📊 No playtime data recorded yet!"))
				}
				var lines []string
				for idx, g := range rows {
					lines = append(lines, fmt.Sprintf("%s **%s** — %s (%d players)", medal(idx), g.GameName, formatPlaytime(g.TotalSeconds), g.Players))
				}
				return Respond(s, i, leaderboardEmbed("🎮 Most Played Games", strings.Join(lines, "\n")))

			case "music":
				rows, err := d.Store.MusicLeaderboard(ctx, i.GuildID, 10)
				if err != nil {
					return err
				}
				if len(rows) == 0 {
					return Respond(s, i, style.BrandEmbed("🎵 No listening data recorded yet!"))
				}
				var lines []string
				for idx, l := range rows {
					lines = append(lines, fmt.Sprintf("%s <@%s> — %s\n %d plays • %d unique tracks",
						medal(idx), l.UserID, formatPlaytime(l.TotalSeconds), l.PlayCount, l.UniqueTracks))
				}
				embed := leaderboardEmbed("🎵 Music Listening Leaderboard", strings.Join(lines, "\n"))
				if top, err := d.Store.MostPlayedTrack(ctx, i.GuildID); err == nil && top != nil {
					artist := top.Artist
					if artist == "" {
						artist = "Unknown"
					}
					embed.Fields = append(embed.Fields, &discordgo.MessageEmbedField{
						Name:  "🏆 Most Played Track",
						Value: fmt.Sprintf("**%s** by %s (%d plays)", top.Title, artist, top.PlayCount),
					})
				}
				return Respond(s, i, embed)
			}
			return fmt.Errorf("unknown leaderboard subcommand %q", sub)
		},
	}
}

func leaderboardEmbed(title, description string) *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title:       title,
		Description: description,
		Color:       style.ColorBrand,
		Footer:      style.Footer(),
	}
}
