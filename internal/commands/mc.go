package commands

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/minecraft"
	"github.com/OlliePCK/packbot/internal/style"
)

// mcPingTimeout bounds the status query. Slash commands are already deferred,
// so this only needs to beat Discord's 15-minute edit window; keep it short so
// an unreachable server reports "offline" promptly rather than hanging.
const mcPingTimeout = 8 * time.Second

// maxSampleNames caps how many player names go in the embed. Servers cap their
// own sample list anyway (vanilla shows 12), this just keeps the field tidy.
const maxSampleNames = 20

// MC is /mc — reports the Pack's Minecraft server status.
//
// This is a pure outbound server-list ping: no plugin, no RCON, no open port
// on the game server. Degrades gracefully when MC_ADDRESS is unset.
func MC(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "mc",
			Description: "Show the Minecraft server's status",
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
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
		},
	}
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
