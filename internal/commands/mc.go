package commands

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/minecraft"
	"github.com/OlliePCK/packbot/internal/style"
)

// mcPingTimeout bounds the status query. Slash commands are already deferred,
// so this only needs to beat Discord's edit window; keep it short so an
// unreachable server reports "offline" promptly rather than hanging.
const mcPingTimeout = 8 * time.Second

// mcRCONTimeout bounds a whitelist command.
const mcRCONTimeout = 10 * time.Second

// maxSampleNames caps how many player names go in the embed. Servers cap their
// own sample list anyway (vanilla shows 12); this keeps the field tidy.
const maxSampleNames = 20

// mcUsernameRe matches a valid Minecraft Java username: 3-16 characters of
// letters, digits and underscore.
//
// This is a security control, not cosmetic input tidying. The username is
// interpolated into a console command sent over RCON, which runs with full
// operator authority — anything that isn't strictly a username must never
// reach that string.
var mcUsernameRe = regexp.MustCompile(`^[A-Za-z0-9_]{3,16}$`)

// MC is /mc — Minecraft server status and whitelist management.
//
// `status` is a pure outbound server-list ping: no plugin, no RCON, no open
// port. `whitelist` needs RCON and is restricted to the bot owner.
func MC(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "mc",
			Description: "Minecraft server status and whitelist",
			Options: []*discordgo.ApplicationCommandOption{
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "status",
					Description: "Show the Minecraft server's status",
				},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "whitelist",
					Description: "Manage the Minecraft whitelist (bot owner only)",
					Options: []*discordgo.ApplicationCommandOption{
						{
							Type:        discordgo.ApplicationCommandOptionString,
							Name:        "action",
							Description: "What to do",
							Required:    true,
							Choices: []*discordgo.ApplicationCommandOptionChoice{
								{Name: "add", Value: "add"},
								{Name: "remove", Value: "remove"},
								{Name: "list", Value: "list"},
							},
						},
						{
							Type:        discordgo.ApplicationCommandOptionString,
							Name:        "player",
							Description: "Minecraft username (required for add and remove)",
						},
					},
				},
			},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			sub, opts := subcommand(i)
			if sub == "whitelist" {
				return mcWhitelist(ctx, d, s, i, opts)
			}
			return mcStatus(ctx, d, s, i)
		},
	}
}

func mcStatus(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate) error {
	if d.MC == nil {
		return Respond(s, i, style.ErrorEmbed(
			"The Minecraft server isn't configured (`MC_ADDRESS` is unset)."))
	}

	ctx, cancel := context.WithTimeout(ctx, mcPingTimeout)
	defer cancel()

	status, err := d.MC.Ping(ctx)
	if err != nil {
		return Respond(s, i, &discordgo.MessageEmbed{
			Title: "Minecraft",
			Description: fmt.Sprintf("%s | **Offline** — couldn't reach `%s`",
				style.Emotes.Error, d.MC.Addr),
			Color:  style.ColorError,
			Footer: style.Footer(),
		})
	}
	return Respond(s, i, mcStatusEmbed(d.MC.Addr, status))
}

func mcWhitelist(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate,
	opts []*discordgo.ApplicationCommandInteractionDataOption) error {

	// RCON runs arbitrary console commands with operator authority, so this is
	// owner-only regardless of Discord permissions.
	user := interactionUser(i)
	if d.AdminUserID == "" || user == nil || user.ID != d.AdminUserID {
		return Respond(s, i, style.ErrorEmbed("Whitelist management is restricted to the bot owner."))
	}
	if d.RCON == nil {
		return Respond(s, i, style.ErrorEmbed(
			"RCON isn't configured (`MC_RCON_ADDRESS` / `MC_RCON_PASSWORD` are unset)."))
	}

	m := optionMap(opts)
	action := ""
	if o, ok := m["action"]; ok {
		action = o.StringValue()
	}

	player := ""
	if o, ok := m["player"]; ok {
		player = strings.TrimSpace(o.StringValue())
	}

	var command string
	switch action {
	case "list":
		command = "whitelist list"
	case "add", "remove":
		if player == "" {
			return Respond(s, i, style.ErrorEmbed(
				fmt.Sprintf("`%s` needs a `player` name.", action)))
		}
		if !mcUsernameRe.MatchString(player) {
			return Respond(s, i, style.ErrorEmbed(
				"That isn't a valid Minecraft username (3-16 letters, digits or underscores)."))
		}
		command = fmt.Sprintf("whitelist %s %s", action, player)
	default:
		return Respond(s, i, style.ErrorEmbed("Unknown action."))
	}

	ctx, cancel := context.WithTimeout(ctx, mcRCONTimeout)
	defer cancel()

	out, err := d.RCON.Exec(ctx, command)
	if err != nil {
		msg := "Couldn't reach the Minecraft server over RCON."
		if errors.Is(err, minecraft.ErrRCONAuthFailed) {
			msg = "RCON rejected the password."
		}
		return Respond(s, i, style.ErrorEmbed(msg))
	}

	if out == "" {
		out = "(no output)"
	}
	return Respond(s, i, &discordgo.MessageEmbed{
		Title:       "Minecraft whitelist",
		Description: fmt.Sprintf("%s | `%s`", style.Emotes.Success, command),
		Color:       style.ColorBrand,
		Footer:      style.Footer(),
		Fields: []*discordgo.MessageEmbedField{
			{Name: "Response", Value: truncate(out, 1000)},
		},
	})
}

// mcStatusEmbed renders a successful ping in PackBot's house style.
func mcStatusEmbed(addr string, st *minecraft.Status) *discordgo.MessageEmbed {
	embed := &discordgo.MessageEmbed{
		Title: "Minecraft",
		Description: fmt.Sprintf("%s | **Online** — `%s`",
			style.Emotes.Success, addr),
		Color:  style.ColorBrand,
		Footer: style.Footer(),
		Fields: []*discordgo.MessageEmbedField{
			{
				Name:   "Players",
				Value:  fmt.Sprintf("%d / %d", st.Players.Online, st.Players.Max),
				Inline: true,
			},
			{
				// Version.Name, not Version.Protocol: with ViaVersion installed
				// the server echoes back the *client's* protocol number so it
				// never looks incompatible, which makes protocol useless here.
				Name:   "Version",
				Value:  fallback(st.Version.Name, "unknown"),
				Inline: true,
			},
			{
				Name:   "Latency",
				Value:  st.Latency.Round(time.Millisecond).String(),
				Inline: true,
			},
		},
	}

	if motd := strings.TrimSpace(st.DescriptionText()); motd != "" {
		embed.Fields = append(embed.Fields, &discordgo.MessageEmbedField{
			Name:  "MOTD",
			Value: motd,
		})
	}

	if names := sampleNames(st); names != "" {
		embed.Fields = append(embed.Fields, &discordgo.MessageEmbedField{
			Name:  "Online now",
			Value: names,
		})
	}

	return embed
}

// sampleNames formats the player sample, which servers may omit entirely even
// when players are online — so an empty result is not "nobody is playing".
func sampleNames(st *minecraft.Status) string {
	if len(st.Players.Sample) == 0 {
		return ""
	}
	names := make([]string, 0, len(st.Players.Sample))
	for _, p := range st.Players.Sample {
		if n := strings.TrimSpace(p.Name); n != "" {
			names = append(names, n)
		}
		if len(names) == maxSampleNames {
			break
		}
	}
	if len(names) == 0 {
		return ""
	}
	out := strings.Join(names, ", ")
	if remaining := st.Players.Online - len(names); remaining > 0 {
		out += fmt.Sprintf(" (+%d more)", remaining)
	}
	return out
}

func fallback(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

// truncate keeps embed fields inside Discord's 1024-character limit.
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-1] + "…"
}
