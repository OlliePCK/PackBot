package commands

import (
	"context"
	"fmt"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/style"
)

// requireVoice returns the caller's voice channel ID, or "" after replying
// with the standard error.
func requireVoice(s *discordgo.Session, i *discordgo.InteractionCreate) string {
	user := interactionUser(i)
	vs, err := s.State.VoiceState(i.GuildID, user.ID)
	if err != nil || vs == nil || vs.ChannelID == "" {
		_ = Respond(s, i, style.ErrorEmbed("You need to be in a voice channel first!"))
		return ""
	}
	return vs.ChannelID
}

// requireMusic replies with the standard error when music is unavailable.
func requireMusic(d Deps, s *discordgo.Session, i *discordgo.InteractionCreate) bool {
	if d.Music == nil {
		_ = Respond(s, i, style.ErrorEmbed("Music is not configured (Lavalink node unavailable)."))
		return false
	}
	return true
}

// Play is /play — full port: URLs (YouTube/SoundCloud/playlists), Spotify
// (track/album/playlist via scored YouTube matching), and text search.
func Play(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "play",
			Description: "Play a song from YouTube, Soundcloud or Spotify",
			Options: []*discordgo.ApplicationCommandOption{{
				Type: discordgo.ApplicationCommandOptionString, Name: "song",
				Description: "Playlist URL, song URL, or search terms", Required: false,
			}},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			voiceChannel := requireVoice(s, i)
			if voiceChannel == "" {
				return nil
			}
			user := interactionUser(i)

			_, opts := subcommand(i)
			om := optionMap(opts)
			opt, ok := om["song"]
			if !ok || opt.StringValue() == "" {
				// No query: resume if paused (Node parity).
				if d.Music.Active(i.GuildID) && d.Music.Paused(i.GuildID) {
					if _, err := d.Music.SetPaused(ctx, i.GuildID, false); err == nil {
						embed := &discordgo.MessageEmbed{
							Description: "▶️ Resumed playback!",
							Color:       style.ColorSuccess,
							Footer:      style.Footer(),
						}
						return Respond(s, i, embed)
					}
				}
				embed := &discordgo.MessageEmbed{
					Description: "⚠️ You must specify what to play.",
					Color:       style.ColorWarn,
					Footer:      style.Footer(),
				}
				return Respond(s, i, embed)
			}
			query := opt.StringValue()

			return playQuery(ctx, d, s, i, query, voiceChannel, user)
		},
	}
}

// playQuery is the shared resolve→join→enqueue flow (used by /play and
// /playlist play).
func playQuery(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate, query, voiceChannel string, user *discordgo.User) error {
	tracks, playlistInfo, err := d.Music.Resolve(ctx, query, user.ID, user.Mention())
	if err != nil {
		return fmt.Errorf("resolve %q: %w", query, err)
	}
	if len(tracks) == 0 {
		return Respond(s, i, style.ErrorEmbed("No results found."))
	}

	if err := d.Music.Join(ctx, i.GuildID, voiceChannel, i.ChannelID); err != nil {
		return err
	}
	queueLen, err := d.Music.Enqueue(ctx, i.GuildID, tracks)
	if err != nil {
		return err
	}

	if playlistInfo != nil {
		embed := &discordgo.MessageEmbed{
			Title:  style.Emotes.Success + " | Playlist added: " + playlistInfo.Title,
			Color:  style.ColorBrand,
			Footer: style.Footer(),
			Fields: []*discordgo.MessageEmbedField{
				{Name: "Songs", Value: fmt.Sprintf("`%d`", playlistInfo.Count), Inline: true},
				{Name: "Requested by", Value: user.Mention(), Inline: true},
			},
		}
		if playlistInfo.URL != "" {
			embed.URL = playlistInfo.URL
		}
		if playlistInfo.Thumbnail != "" {
			embed.Image = &discordgo.MessageEmbedImage{URL: playlistInfo.Thumbnail}
		}
		return Respond(s, i, embed)
	}

	track := tracks[0]
	embed := &discordgo.MessageEmbed{
		Title:  style.Emotes.Success + " | Song added: " + track.Title,
		URL:    track.DisplayURL(),
		Color:  style.ColorBrand,
		Footer: style.Footer(),
		Fields: []*discordgo.MessageEmbedField{
			{Name: "Duration", Value: "`" + track.FormattedDuration() + "`", Inline: true},
			{Name: "Requested by", Value: user.Mention(), Inline: true},
			{Name: "Position in queue", Value: fmt.Sprintf("%d", queueLen), Inline: true},
		},
	}
	if track.Thumbnail != "" {
		embed.Thumbnail = &discordgo.MessageEmbedThumbnail{URL: track.Thumbnail}
	}
	return Respond(s, i, embed)
}
