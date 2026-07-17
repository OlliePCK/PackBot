package commands

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/style"
)

var birthdayMonths = []string{
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
}

var birthdayDateRe = regexp.MustCompile(`^(\d{1,2})-(\d{1,2})$`)

// parseBirthdayDate validates MM-DD input; returns month, day and ok.
func parseBirthdayDate(input string) (int, int, bool) {
	m := birthdayDateRe.FindStringSubmatch(strings.TrimSpace(input))
	if m == nil {
		return 0, 0, false
	}
	month, _ := strconv.Atoi(m[1])
	day, _ := strconv.Atoi(m[2])
	if month < 1 || month > 12 || day < 1 || day > 31 {
		return 0, 0, false
	}
	return month, day, true
}

func formatBirthdayDate(month, day int) string {
	return fmt.Sprintf("%s %d", birthdayMonths[month-1], day)
}

// Birthday is /birthday — admin-only birthday reminder management.
func Birthday(d Deps) *Command {
	adminOnly := int64(discordgo.PermissionAdministrator)

	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:                     "birthday",
			Description:              "Manage birthday reminders.",
			DefaultMemberPermissions: &adminOnly,
			Options: []*discordgo.ApplicationCommandOption{
				{
					Type: discordgo.ApplicationCommandOptionSubCommand, Name: "add",
					Description: "Add a birthday to the reminder list.",
					Options: []*discordgo.ApplicationCommandOption{
						{Type: discordgo.ApplicationCommandOptionUser, Name: "user", Description: "The person whose birthday to add.", Required: true},
						{Type: discordgo.ApplicationCommandOptionString, Name: "date", Description: "Birthday date in MM-DD format (e.g. 03-15 for March 15).", Required: true},
					},
				},
				{
					Type: discordgo.ApplicationCommandOptionSubCommand, Name: "remove",
					Description: "Remove a birthday from the reminder list.",
					Options: []*discordgo.ApplicationCommandOption{
						{Type: discordgo.ApplicationCommandOptionUser, Name: "user", Description: "The person whose birthday to remove.", Required: true},
					},
				},
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "list", Description: "View all saved birthdays."},
			},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			sub, opts := subcommand(i)
			om := optionMap(opts)

			switch sub {
			case "add":
				target := om["user"].UserValue(s)
				month, day, ok := parseBirthdayDate(om["date"].StringValue())
				if !ok {
					return Respond(s, i, style.ErrorEmbed("Invalid date format. Use MM-DD (e.g. `03-15` for March 15)."))
				}
				name := displayName(target)
				if err := d.Store.UpsertBirthday(ctx, i.GuildID, target.ID, name, month, day); err != nil {
					return err
				}
				embed := &discordgo.MessageEmbed{
					Title:       style.Emotes.Success + " | Birthday Added",
					Description: fmt.Sprintf("**%s**'s birthday has been set to **%s**.", name, formatBirthdayDate(month, day)),
					Color:       style.ColorBrand,
					Footer:      style.Footer(),
					Thumbnail:   &discordgo.MessageEmbedThumbnail{URL: target.AvatarURL("128")},
				}
				return Respond(s, i, embed)

			case "remove":
				target := om["user"].UserValue(s)
				removed, err := d.Store.DeleteBirthday(ctx, i.GuildID, target.ID)
				if err != nil {
					return err
				}
				if !removed {
					return Respond(s, i, style.ErrorEmbed(displayName(target)+" doesn't have a birthday saved."))
				}
				embed := &discordgo.MessageEmbed{
					Title:       style.Emotes.Success + " | Birthday Removed",
					Description: fmt.Sprintf("**%s**'s birthday has been removed.", displayName(target)),
					Color:       style.ColorBrand,
					Footer:      style.Footer(),
				}
				return Respond(s, i, embed)

			case "list":
				birthdays, err := d.Store.ListBirthdays(ctx, i.GuildID)
				if err != nil {
					return err
				}
				if len(birthdays) == 0 {
					return Respond(s, i, style.BrandEmbed("No birthdays saved yet. Use `/birthday add` to add some!"))
				}
				var lines []string
				for _, b := range birthdays {
					lines = append(lines, fmt.Sprintf("<@%s> — **%s**", b.UserID, formatBirthdayDate(b.Month, b.Day)))
				}
				embed := &discordgo.MessageEmbed{
					Title:       "Birthdays",
					Description: strings.Join(lines, "\n"),
					Color:       style.ColorBrand,
					Footer:      style.Footer(),
				}
				return Respond(s, i, embed)
			}
			return fmt.Errorf("unknown birthday subcommand %q", sub)
		},
	}
}
