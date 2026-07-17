package commands

import (
	"context"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/style"
)

// Ping is /ping — replies with a branded "Pong!" embed.
func Ping() *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "ping",
			Description: "Replies with Pong!",
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			return Respond(s, i, style.BrandEmbed("🏓 Pong!"))
		},
	}
}
