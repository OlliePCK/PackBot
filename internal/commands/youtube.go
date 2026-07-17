package commands

import (
	"context"
	"fmt"
	"strings"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
	"github.com/OlliePCK/packbot/internal/youtube"
)

// YouTube is /youtube — manages the upload-notification watch-list.
// d.YouTube is nil when YOUTUBE_API_KEY is unset; the command degrades gracefully.
func YouTube(d Deps) *Command {
	yt := d.YouTube
	adminOnly := int64(discordgo.PermissionAdministrator)

	handleOption := &discordgo.ApplicationCommandOption{
		Type: discordgo.ApplicationCommandOptionString, Name: "handle",
		Description: "The @handle of the YouTube channel.", Required: true,
	}

	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:                     "youtube",
			Description:              "Configure YouTube notifications.",
			DefaultMemberPermissions: &adminOnly,
			Options: []*discordgo.ApplicationCommandOption{
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "add", Description: "Add a YouTube channel to the notification list.", Options: []*discordgo.ApplicationCommandOption{handleOption}},
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "remove", Description: "Remove a YouTube channel from the notification list.", Options: []*discordgo.ApplicationCommandOption{handleOption}},
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "view", Description: "View the YouTube notification list."},
			},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if yt == nil {
				return Respond(s, i, style.ErrorEmbed("YouTube features are not configured (missing API key)."))
			}

			sub, opts := subcommand(i)
			om := optionMap(opts)

			switch sub {
			case "add":
				handle := strings.TrimPrefix(strings.TrimSpace(om["handle"].StringValue()), "@")

				profile, err := d.Store.GuildProfile(ctx, i.GuildID)
				if err != nil {
					return err
				}
				if profile.YouTubeChannelID == nil || *profile.YouTubeChannelID == "" {
					return Respond(s, i, style.ErrorEmbed("You haven't set a YouTube notifications channel. Run `/settings set-youtube-channel` first."))
				}

				channel, err := yt.ChannelByHandle(ctx, handle)
				if err != nil {
					return err
				}
				if channel == nil {
					return Respond(s, i, style.ErrorEmbed("Invalid YouTube handle—please try again."))
				}

				if err := d.Store.AddWatchedChannel(ctx, handle, channel.ID, i.GuildID); err != nil {
					if storage.IsDuplicateKey(err) {
						return Respond(s, i, style.ErrorEmbed("That channel is already in the notification list."))
					}
					return err
				}

				embed := youtubeChannelEmbed(style.Emotes.Success+" | YouTube Channel Added", handle, channel)
				return Respond(s, i, embed)

			case "remove":
				handle := strings.TrimPrefix(strings.TrimSpace(om["handle"].StringValue()), "@")

				removed, err := d.Store.RemoveWatchedChannel(ctx, handle, i.GuildID)
				if err != nil {
					return err
				}
				if !removed {
					return Respond(s, i, style.ErrorEmbed("That channel isn't in the notification list."))
				}

				// Best-effort channel info for the confirmation embed (the Node
				// version errored out entirely when this lookup failed).
				channel, err := yt.ChannelByHandle(ctx, handle)
				if err != nil || channel == nil {
					embed := &discordgo.MessageEmbed{
						Title:  style.Emotes.Success + " | YouTube Channel Removed",
						URL:    "https://www.youtube.com/@" + handle,
						Color:  style.ColorBrand,
						Footer: style.Footer(),
						Fields: []*discordgo.MessageEmbedField{{Name: "Handle", Value: "@" + handle, Inline: true}},
					}
					return Respond(s, i, embed)
				}
				embed := youtubeChannelEmbed(style.Emotes.Success+" | YouTube Channel Removed", handle, channel)
				embed.Thumbnail = nil
				return Respond(s, i, embed)

			case "view":
				watched, err := d.Store.ListWatchedChannels(ctx, i.GuildID)
				if err != nil {
					return err
				}
				if len(watched) == 0 {
					return Respond(s, i, style.BrandEmbed("ℹ️ No YouTube channels configured."))
				}

				var fields []*discordgo.MessageEmbedField
				for _, w := range watched {
					value := fmt.Sprintf("[@`%s`](https://www.youtube.com/@%s)", w.Handle, w.Handle)
					if channel, err := yt.ChannelByHandle(ctx, w.Handle); err == nil && channel != nil {
						fields = append(fields, &discordgo.MessageEmbedField{
							Name:   channel.Title,
							Value:  fmt.Sprintf("%s\nSubs: %s • Videos: %s", value, channel.SubscriberCount, channel.VideoCount),
							Inline: true,
						})
					} else {
						fields = append(fields, &discordgo.MessageEmbedField{Name: "@" + w.Handle, Value: value, Inline: true})
					}
				}

				embed := &discordgo.MessageEmbed{
					Title:       "YouTube Notification List",
					Description: "Channels I will notify you about:",
					Thumbnail:   &discordgo.MessageEmbedThumbnail{URL: "https://i.imgur.com/FWS5J0N.png"},
					Color:       style.ColorBrand,
					Footer:      style.Footer(),
					Fields:      fields,
				}
				return Respond(s, i, embed)
			}
			return fmt.Errorf("unknown youtube subcommand %q", sub)
		},
	}
}

func youtubeChannelEmbed(title, handle string, channel *youtube.Channel) *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title:     title,
		URL:       "https://www.youtube.com/@" + handle,
		Color:     style.ColorBrand,
		Footer:    style.Footer(),
		Thumbnail: &discordgo.MessageEmbedThumbnail{URL: channel.ThumbnailURL},
		Fields: []*discordgo.MessageEmbedField{
			{Name: "Name", Value: channel.Title, Inline: true},
			{Name: "Subscribers", Value: channel.SubscriberCount, Inline: true},
			{Name: "Videos", Value: channel.VideoCount, Inline: true},
		},
	}
}
