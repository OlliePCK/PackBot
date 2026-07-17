package commands

import (
	"context"
	"fmt"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/style"
)

// settingsSetter drives the table-driven setter subcommands (parity with the
// Node SETTERS map). Starboard setters were dropped with the feature.
type settingsSetter struct {
	option    string // option name carrying the value
	column    string // Guilds column (must be whitelisted in storage)
	isRole    bool   // role option instead of channel option
	title     string
	fieldName string
}

var settingsSetters = map[string]settingsSetter{
	"set-live-role":       {option: "live-role", column: "liveRoleID", isRole: true, title: "Set live role!", fieldName: "Role"},
	"set-live-channel":    {option: "live-channel", column: "liveChannelID", title: "Set live channel!", fieldName: "Channel"},
	"set-general-channel": {option: "general-channel", column: "generalChannelID", title: "Set general channel!", fieldName: "Channel"},
	"set-youtube-channel": {option: "youtube-channel", column: "youtubeChannelID", title: "Set YouTube channel!", fieldName: "Channel"},
}

// Settings is /settings — admin-only, ephemeral guild configuration.
func Settings(d Deps) *Command {
	adminOnly := int64(discordgo.PermissionAdministrator)

	channelSub := func(name, desc, option string) *discordgo.ApplicationCommandOption {
		return &discordgo.ApplicationCommandOption{
			Type: discordgo.ApplicationCommandOptionSubCommand, Name: name, Description: desc,
			Options: []*discordgo.ApplicationCommandOption{{
				Type: discordgo.ApplicationCommandOptionChannel, Name: option,
				Description: "Text channel", Required: true,
			}},
		}
	}

	return &Command{
		Ephemeral: true,
		Def: &discordgo.ApplicationCommand{
			Name:                     "settings",
			Description:              "Change the bot's settings (admin only)",
			DefaultMemberPermissions: &adminOnly,
			Options: []*discordgo.ApplicationCommandOption{
				{
					Type: discordgo.ApplicationCommandOptionSubCommand, Name: "set-live-role",
					Description: "Assign role when users go live",
					Options: []*discordgo.ApplicationCommandOption{{
						Type: discordgo.ApplicationCommandOptionRole, Name: "live-role",
						Description: "Role to assign", Required: true,
					}},
				},
				channelSub("set-live-channel", "Channel for live notifications", "live-channel"),
				channelSub("set-general-channel", "Channel for general notifications", "general-channel"),
				channelSub("set-youtube-channel", "Channel for YouTube notifications", "youtube-channel"),
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "info", Description: "View current settings"},
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "toggle-247", Description: "Toggle 24/7 mode (bot stays in voice channel when alone)"},
			},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			sub, opts := subcommand(i)
			user := interactionUser(i)

			profile, err := d.Store.GuildProfile(ctx, i.GuildID)
			if err != nil {
				return err
			}

			if sub == "info" {
				display := func(v *string, format string) string {
					if v == nil || *v == "" {
						return "`Not set`"
					}
					return fmt.Sprintf(format, *v)
				}
				mode := "`Disabled`"
				if profile.TwentyFourSevenMode {
					mode = "`Enabled`"
				}
				embed := &discordgo.MessageEmbed{
					Title:       guildName(s, i.GuildID) + " Settings",
					Description: "Use `/settings set-<thing>` to update these.",
					Color:       style.ColorBrand,
					Footer:      style.Footer(),
					Fields: []*discordgo.MessageEmbedField{
						{Name: "Live Role", Value: display(profile.LiveRoleID, "<@&%s>"), Inline: true},
						{Name: "Live Channel", Value: display(profile.LiveChannelID, "<#%s>"), Inline: true},
						{Name: "General Chan", Value: display(profile.GeneralChannelID, "<#%s>"), Inline: true},
						{Name: "YouTube Chan", Value: display(profile.YouTubeChannelID, "<#%s>"), Inline: true},
						{Name: "24/7 Mode", Value: mode, Inline: true},
					},
				}
				return Respond(s, i, embed)
			}

			if sub == "toggle-247" {
				newValue := 0
				display := "`Disabled`"
				if !profile.TwentyFourSevenMode {
					newValue = 1
					display = "`Enabled`"
				}
				if err := d.Store.UpdateGuildSetting(ctx, i.GuildID, "twentyFourSevenMode", newValue); err != nil {
					return err
				}
				return Respond(s, i, settingsSuccessEmbed("24/7 Mode toggled!", "Status", display, user))
			}

			cfg, ok := settingsSetters[sub]
			if !ok {
				return fmt.Errorf("unknown settings subcommand %q", sub)
			}
			om := optionMap(opts)
			opt := om[cfg.option]
			if opt == nil {
				return fmt.Errorf("missing option %q", cfg.option)
			}

			var id, mention string
			if cfg.isRole {
				id = opt.Value.(string)
				mention = "<@&" + id + ">"
			} else {
				id = opt.Value.(string)
				mention = "<#" + id + ">"
				// Node validated ch.isTextBased(); use the resolved channel data.
				if resolved := i.ApplicationCommandData().Resolved; resolved != nil {
					if ch, ok := resolved.Channels[id]; ok && !isTextChannel(ch.Type) {
						return Respond(s, i, style.ErrorEmbed("That is not a text channel!"))
					}
				}
			}

			if err := d.Store.UpdateGuildSetting(ctx, i.GuildID, cfg.column, id); err != nil {
				return err
			}
			return Respond(s, i, settingsSuccessEmbed(cfg.title, cfg.fieldName, mention, user))
		},
	}
}

func settingsSuccessEmbed(title, fieldName, value string, user *discordgo.User) *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title:  style.Emotes.Success + " | " + title,
		Color:  style.ColorBrand,
		Footer: style.Footer(),
		Fields: []*discordgo.MessageEmbedField{
			{Name: fieldName, Value: value, Inline: true},
			{Name: "Set by", Value: user.Mention(), Inline: true},
		},
	}
}

func isTextChannel(t discordgo.ChannelType) bool {
	switch t {
	case discordgo.ChannelTypeGuildText, discordgo.ChannelTypeGuildNews,
		discordgo.ChannelTypeGuildNewsThread, discordgo.ChannelTypeGuildPublicThread,
		discordgo.ChannelTypeGuildPrivateThread:
		return true
	default:
		return false
	}
}

func guildName(s *discordgo.Session, guildID string) string {
	if g, err := s.State.Guild(guildID); err == nil && g.Name != "" {
		return g.Name
	}
	return "Server"
}
