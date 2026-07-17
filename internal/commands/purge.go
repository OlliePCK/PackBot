package commands

import (
	"context"
	"fmt"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/style"
)

// bulkDeleteMaxAge: Discord's bulk-delete endpoint rejects messages older
// than 14 days; the Node bot passed filterOld=true to skip them silently.
const bulkDeleteMaxAge = 14 * 24 * time.Hour

// Purge is /purge — bulk message deletion. Parity note: like the Node bot,
// the admin check is in-code (the command is visible to everyone).
func Purge() *Command {
	return &Command{
		Ephemeral: true,
		Def: &discordgo.ApplicationCommand{
			Name:        "purge",
			Description: "Mass deletes messages (max 100).",
			Options: []*discordgo.ApplicationCommandOption{{
				Type: discordgo.ApplicationCommandOptionInteger, Name: "amount",
				Description: "Number of messages to delete (1–100)", Required: true,
			}},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if i.Member == nil || i.Member.Permissions&discordgo.PermissionAdministrator == 0 {
				return Respond(s, i, style.ErrorEmbed("You need Administrator permissions to do that."))
			}

			_, opts := subcommand(i)
			amount := int(optionMap(opts)["amount"].IntValue())
			if amount < 1 || amount > 100 {
				return Respond(s, i, style.ErrorEmbed("Please specify a number between 1 and 100."))
			}

			messages, err := s.ChannelMessages(i.ChannelID, amount, "", "", "")
			if err != nil {
				return Respond(s, i, style.ErrorEmbed("Couldn't delete messages. Make sure I have permissions and messages are under 14 days old."))
			}

			cutoff := time.Now().Add(-bulkDeleteMaxAge)
			var ids []string
			for _, m := range messages {
				if m.Timestamp.After(cutoff) {
					ids = append(ids, m.ID)
				}
			}

			count := len(ids)
			switch {
			case count == 0:
				// nothing young enough to delete
			case count == 1:
				err = s.ChannelMessageDelete(i.ChannelID, ids[0])
			default:
				err = s.ChannelMessagesBulkDelete(i.ChannelID, ids)
			}
			if err != nil {
				return Respond(s, i, style.ErrorEmbed("Couldn't delete messages. Make sure I have permissions and messages are under 14 days old."))
			}

			embed := &discordgo.MessageEmbed{
				Description: fmt.Sprintf("🗑️ Deleted **%d** message%s.", count, plural(count)),
				Color:       style.ColorSuccess,
				Footer:      style.Footer(),
			}
			return Respond(s, i, embed)
		},
	}
}
