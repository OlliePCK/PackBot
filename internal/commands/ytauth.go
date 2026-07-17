package commands

import (
	"context"
	"fmt"
	"strings"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/style"
)

// YTAuth is /ytauth — bot-owner upkeep for the YouTube OAuth refresh token.
// It pairs with the login-wall alert DM the music manager sends: the owner
// mints a fresh token (device-code flow on any Lavalink) and submits it here,
// and the bot pushes it into the running node — no container restart.
//
// The command is restricted to the bot's DMs: tokens are secrets and have no
// business being typed in a guild channel, ephemeral or not.
func YTAuth(d Deps) *Command {
	dmOnly := []discordgo.InteractionContextType{discordgo.InteractionContextBotDM}
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "ytauth",
			Description: "Manage the YouTube OAuth refresh token (bot owner only)",
			Contexts:    &dmOnly,
			Options: []*discordgo.ApplicationCommandOption{
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "set",
					Description: "Push a new refresh token into Lavalink (applies immediately)",
					Options: []*discordgo.ApplicationCommandOption{
						{
							Type:        discordgo.ApplicationCommandOptionString,
							Name:        "token",
							Description: "The OAuth refresh token from the Lavalink device-link log (starts with 1//)",
							Required:    true,
						},
					},
				},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "status",
					Description: "Check whether Lavalink currently holds a refresh token",
				},
			},
		},
		Ephemeral: true,
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			user := interactionUser(i)
			if d.AdminUserID == "" || user == nil || user.ID != d.AdminUserID {
				return Respond(s, i, style.ErrorEmbed("This command is restricted to the bot owner."))
			}
			if d.Music == nil {
				return Respond(s, i, style.ErrorEmbed("Music is disabled (no Lavalink connection)."))
			}

			sub, opts := subcommand(i)
			switch sub {
			case "set":
				token := strings.TrimSpace(optionMap(opts)["token"].StringValue())
				if err := d.Music.SetYouTubeRefreshToken(ctx, token); err != nil {
					return Respond(s, i, style.ErrorEmbed("Lavalink rejected the token update: "+err.Error()))
				}
				return Respond(s, i, style.BrandEmbed(style.Emotes.Success+
					" | Refresh token applied — YouTube playback should recover immediately.\n\n"+
					"To survive a Lavalink **restart**, also pin this token in "+
					"`/mnt/user/appdata/packbot-lavalink/application.yml` "+
					"(`refreshToken:` under `plugins.youtube.oauth`, with `skipInitialization: true`)."))
			case "status":
				token, err := d.Music.YouTubeRefreshToken(ctx)
				if err != nil {
					return Respond(s, i, style.ErrorEmbed("Couldn't read OAuth state from Lavalink: "+err.Error()))
				}
				if token == "" {
					return Respond(s, i, style.BrandEmbed("No refresh token is loaded — YouTube OAuth is inactive."))
				}
				return Respond(s, i, style.BrandEmbed(fmt.Sprintf(
					"A refresh token is loaded (ends in `…%s`).", tokenTail(token))))
			}
			return Respond(s, i, style.ErrorEmbed("Unknown subcommand."))
		},
	}
}

// tokenTail returns the last few characters of a token for display — enough
// to compare against a known token, never enough to reconstruct it.
func tokenTail(token string) string {
	const n = 6
	if len(token) <= n {
		return token
	}
	return token[len(token)-n:]
}
