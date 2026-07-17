package commands

// The music control command set (Node: one file per command). Handlers that
// trigger announcement embeds (skip/stop/jump/previous) delete their own
// deferred reply — the manager's event embeds are the visible response,
// parity with the Node bot.

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/music"
	"github.com/OlliePCK/packbot/internal/style"
)

func deleteReply(s *discordgo.Session, i *discordgo.InteractionCreate) error {
	return s.InteractionResponseDelete(i.Interaction)
}

func simpleSuccess(description string) *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Description: description,
		Color:       style.ColorSuccess,
		Footer:      style.Footer(),
	}
}

// Join is /join.
func Join(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{Name: "join", Description: "Join your voice channel"},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			voiceChannel := requireVoice(s, i)
			if voiceChannel == "" {
				return nil
			}
			if err := d.Music.Join(ctx, i.GuildID, voiceChannel, i.ChannelID); err != nil {
				return err
			}
			name := "your channel"
			if ch, err := s.State.Channel(voiceChannel); err == nil {
				name = ch.Name
			}
			return Respond(s, i, simpleSuccess(fmt.Sprintf("%s | Joined **%s**!", style.Emotes.Success, name)))
		},
	}
}

// Leave is /leave.
func Leave(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{Name: "leave", Description: "Leave the voice channel"},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			if err := d.Music.Leave(ctx, i.GuildID); err != nil {
				return Respond(s, i, style.ErrorEmbed("Not in a voice channel."))
			}
			return Respond(s, i, simpleSuccess("👋 Left the voice channel."))
		},
	}
}

// Skip is /skip.
func Skip(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{Name: "skip", Description: "Skip the current song"},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			if err := d.Music.Skip(ctx, i.GuildID, interactionUser(i).Mention()); err != nil {
				return Respond(s, i, style.ErrorEmbed("Not playing anything."))
			}
			return deleteReply(s, i)
		},
	}
}

// StopMusic is /stop — clears the queue, stays in channel.
func StopMusic(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{Name: "stop", Description: "Stop the music and clear the queue"},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			if !d.Music.Active(i.GuildID) {
				return Respond(s, i, style.ErrorEmbed("Not playing anything."))
			}
			if err := d.Music.Stop(ctx, i.GuildID, interactionUser(i).Mention()); err != nil {
				return err
			}
			return deleteReply(s, i)
		},
	}
}

// Pause is /pause — toggles pause/resume (Node parity).
func Pause(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{Name: "pause", Description: "Pauses or resumes the currently playing music."},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) || !d.Music.Active(i.GuildID) {
				if d.Music != nil {
					return Respond(s, i, style.ErrorEmbed("Not playing anything."))
				}
				return nil
			}
			paused := d.Music.Paused(i.GuildID)
			if _, err := d.Music.SetPaused(ctx, i.GuildID, !paused); err != nil {
				return Respond(s, i, style.ErrorEmbed("Not playing anything."))
			}
			if paused {
				return Respond(s, i, simpleSuccess(style.Emotes.Play+" | Resumed playback."))
			}
			embed := &discordgo.MessageEmbed{
				Description: style.Emotes.Pause + " | Paused playback.",
				Color:       style.ColorWarn,
				Footer:      style.Footer(),
			}
			return Respond(s, i, embed)
		},
	}
}

// Volume is /volume.
func Volume(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "volume",
			Description: "Set the volume level of the audio player (0–200).",
			Options: []*discordgo.ApplicationCommandOption{{
				Type: discordgo.ApplicationCommandOptionInteger, Name: "volume",
				Description: "Volume level from 0 to 200", Required: true,
			}},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			if !d.Music.Active(i.GuildID) {
				return Respond(s, i, style.ErrorEmbed("Not playing anything."))
			}
			_, opts := subcommand(i)
			vol := int(optionMap(opts)["volume"].IntValue())
			if vol < 0 || vol > 200 {
				return Respond(s, i, style.ErrorEmbed("Please enter a number between 0 and 200."))
			}
			if err := d.Music.SetVolume(ctx, i.GuildID, vol); err != nil {
				return err
			}
			return Respond(s, i, simpleSuccess(fmt.Sprintf("🔊 Volume set to **%d%%**", vol)))
		},
	}
}

// Seek is /seek.
func Seek(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "seek",
			Description: "Skip to a certain point in the song.",
			Options: []*discordgo.ApplicationCommandOption{{
				Type: discordgo.ApplicationCommandOptionInteger, Name: "time",
				Description: "Number of seconds to seek", Required: true,
			}},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			gp := d.Music.Guild(i.GuildID)
			current := gp.CurrentTrack()
			if current == nil {
				return Respond(s, i, style.ErrorEmbed("Not playing anything."))
			}
			_, opts := subcommand(i)
			seconds := int(optionMap(opts)["time"].IntValue())
			if seconds < 0 || (current.Duration > 0 && float64(seconds) > current.Duration.Seconds()) {
				return Respond(s, i, style.ErrorEmbed(fmt.Sprintf("Please enter a time between 0 and %d seconds.", int(current.Duration.Seconds()))))
			}
			if err := d.Music.Seek(ctx, i.GuildID, time.Duration(seconds)*time.Second); err != nil {
				return Respond(s, i, style.ErrorEmbed("Couldn't seek to that position."))
			}
			return Respond(s, i, simpleSuccess(fmt.Sprintf("⏩ Seeked to **%d:%02d** in **%s**", seconds/60, seconds%60, current.Title)))
		},
	}
}

// Repeat is /repeat.
func Repeat(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "repeat",
			Description: "Set the repeat mode of the currently playing music.",
			Options: []*discordgo.ApplicationCommandOption{{
				Type: discordgo.ApplicationCommandOptionString, Name: "mode",
				Description: "Repeat modes", Required: true,
				Choices: []*discordgo.ApplicationCommandOptionChoice{
					{Name: "Queue repeat", Value: "queue"},
					{Name: "Song repeat", Value: "song"},
					{Name: "Repeat off", Value: "off"},
				},
			}},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			if !d.Music.Active(i.GuildID) {
				return Respond(s, i, style.ErrorEmbed("Not playing anything."))
			}
			_, opts := subcommand(i)
			choice := optionMap(opts)["mode"].StringValue()
			var mode music.RepeatMode
			var text string
			switch choice {
			case "song":
				mode, text = music.RepeatSong, "Repeat song"
			case "queue":
				mode, text = music.RepeatQueue, "Repeat queue"
			default:
				mode, text = music.RepeatOff, "Off"
			}
			d.Music.Guild(i.GuildID).SetRepeatMode(mode)
			return Respond(s, i, simpleSuccess(style.Emotes.Repeat+" Repeat mode set to **"+text+"**"))
		},
	}
}

// Shuffle is /shuffle.
func Shuffle(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{Name: "shuffle", Description: "Shuffles all songs in the queue."},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			gp := d.Music.Guild(i.GuildID)
			n := gp.ShuffleQueue()
			if n == 0 {
				return Respond(s, i, style.ErrorEmbed("Queue is empty."))
			}
			return Respond(s, i, simpleSuccess(fmt.Sprintf("🔀 Shuffled **%d** songs in the queue.", n)))
		},
	}
}

// Previous is /previous.
func Previous(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{Name: "previous", Description: "Plays the previous song."},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			if _, err := d.Music.Previous(ctx, i.GuildID); err != nil {
				return Respond(s, i, style.ErrorEmbed("No previous track available."))
			}
			return deleteReply(s, i)
		},
	}
}

// Autoplay is /autoplay.
func Autoplay(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{Name: "autoplay", Description: "Toggles the autoplay of music after the queue finishes."},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			if !d.Music.Active(i.GuildID) {
				return Respond(s, i, style.ErrorEmbed("There is nothing in the queue right now!"))
			}
			gp := d.Music.Guild(i.GuildID)
			enabled := gp.ToggleAutoplay()
			state, description := "Off", "⏹️ Playback will stop when the queue ends."
			if enabled {
				state, description = "On", "🔄 When the queue ends, related songs will be automatically added."
			}
			embed := &discordgo.MessageEmbed{
				Title:       fmt.Sprintf("%s | Autoplay: `%s`", style.Emotes.Success, state),
				Description: description,
				Color:       style.ColorBrand,
				Footer:      style.Footer(),
				Fields: []*discordgo.MessageEmbedField{
					{Name: "Requested by", Value: interactionUser(i).Mention(), Inline: true},
				},
			}
			return Respond(s, i, embed)
		},
	}
}

// Jump is /jump.
func Jump(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "jump",
			Description: "Jump to a song position in the queue.",
			Options: []*discordgo.ApplicationCommandOption{{
				Type: discordgo.ApplicationCommandOptionInteger, Name: "position",
				Description: "1 = first in queue, 2 = second... -1 = last, -2 = second-last, etc.", Required: true,
			}},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			gp := d.Music.Guild(i.GuildID)
			length := gp.QueueLength()
			if length == 0 {
				return Respond(s, i, style.ErrorEmbed("Queue is empty."))
			}
			_, opts := subcommand(i)
			pos := int(optionMap(opts)["position"].IntValue())
			index := pos - 1
			if pos < 0 {
				index = length + pos
			}
			if index < 0 || index >= length {
				return Respond(s, i, style.ErrorEmbed(fmt.Sprintf("Invalid position. Use 1-%d or -1 to -%d.", length, length)))
			}
			if _, err := d.Music.JumpTo(ctx, i.GuildID, index); err != nil {
				return Respond(s, i, style.ErrorEmbed("Couldn't jump to that position."))
			}
			return deleteReply(s, i)
		},
	}
}

// Swap is /swap.
func Swap(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "swap",
			Description: "Swap the positions of two songs in the queue.",
			Options: []*discordgo.ApplicationCommandOption{
				{Type: discordgo.ApplicationCommandOptionInteger, Name: "position_1", Description: "The position of the first song to swap (1 = first in queue).", Required: true},
				{Type: discordgo.ApplicationCommandOptionInteger, Name: "position_2", Description: "The position of the second song to swap.", Required: true},
			},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			gp := d.Music.Guild(i.GuildID)
			_, opts := subcommand(i)
			om := optionMap(opts)
			pos1, pos2 := int(om["position_1"].IntValue()), int(om["position_2"].IntValue())
			if err := gp.SwapQueue(pos1-1, pos2-1); err != nil {
				return Respond(s, i, style.ErrorEmbed(err.Error()))
			}
			return Respond(s, i, simpleSuccess(fmt.Sprintf("🔀 Swapped positions **%d** and **%d**.", pos1, pos2)))
		},
	}
}

// Push is /push — move a song to the front of the queue.
func Push(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "push",
			Description: "Move a song to play next (position 1 in queue).",
			Options: []*discordgo.ApplicationCommandOption{{
				Type: discordgo.ApplicationCommandOptionInteger, Name: "position",
				Description: "The position of the song to move (1 = first in queue)", Required: true,
			}},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			gp := d.Music.Guild(i.GuildID)
			_, opts := subcommand(i)
			pos := int(optionMap(opts)["position"].IntValue())
			track, err := gp.PushToFront(pos - 1)
			if err != nil {
				return Respond(s, i, style.ErrorEmbed(err.Error()))
			}
			return Respond(s, i, simpleSuccess(fmt.Sprintf("⏫ **%s** moved to play next.", track.Title)))
		},
	}
}

// Undo is /undo — removes the last queued song.
func Undo(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{Name: "undo", Description: "Removes the last song from the queue."},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			gp := d.Music.Guild(i.GuildID)
			removed := gp.PopLast()
			if removed == nil {
				return Respond(s, i, style.ErrorEmbed("The queue is empty—nothing to remove!"))
			}
			embed := &discordgo.MessageEmbed{
				Title:       style.Emotes.Success + " | Removed from queue",
				Description: fmt.Sprintf("**%s** has been removed.", removed.Title),
				Color:       style.ColorBrand,
				Footer:      style.Footer(),
				Fields: []*discordgo.MessageEmbedField{
					{Name: "Requested by", Value: interactionUser(i).Mention(), Inline: true},
				},
			}
			return Respond(s, i, embed)
		},
	}
}

// NowPlaying is /nowplaying.
// npCtlPrefix routes /nowplaying's control buttons ("np_ctl:pause" etc.).
const npCtlPrefix = "np_ctl:"

// renderNowPlayingCard builds the hand-crafted V2 now-playing card with
// playback controls — the show-piece of the Components-V2 restyle (the rest
// of the bot converts embeds at the send boundary; this composes directly).
func renderNowPlayingCard(d Deps, guildID string) ([]discordgo.MessageComponent, bool) {
	gp := d.Music.Guild(guildID)
	current := gp.CurrentTrack()
	if current == nil {
		return nil, false
	}

	position := d.Music.Position(guildID)
	total := current.Duration
	bar := progressBar(position.Seconds(), total.Seconds(), 12)
	snapshot := gp.Snapshot()
	paused := d.Music.Paused(guildID)

	loop := snapshot.RepeatMode.String()
	if snapshot.RepeatMode != music.RepeatOff {
		loop = style.Emotes.Repeat + " " + loop
	}

	status := style.Emotes.Play + " Now Playing"
	if paused {
		status = style.Emotes.Pause + " Paused"
	}
	head := fmt.Sprintf("### %s\n**%s**\nby %s", status, style.MaskedLink(current.Title, current.DisplayURL()), orUnknown(current.Artist))

	var children []discordgo.MessageComponent
	headText := discordgo.TextDisplay{Content: head}
	if current.Thumbnail != "" {
		children = append(children, discordgo.Section{
			Components: []discordgo.MessageComponent{headText},
			Accessory:  discordgo.Thumbnail{Media: discordgo.UnfurledMediaItem{URL: current.Thumbnail}},
		})
	} else {
		children = append(children, headText)
	}

	info := fmt.Sprintf("%s `%s / %s`\n**Volume** `%d%%` · **Loop** %s · **Requested by** %s",
		bar, formatSeconds(int(position.Seconds())), formatSeconds(int(total.Seconds())),
		snapshot.Volume, loop, current.Requester)
	if len(snapshot.Queue) > 0 {
		info += fmt.Sprintf("\n**Up Next (%d in queue)** %s", len(snapshot.Queue), snapshot.Queue[0].Title)
	}
	if snapshot.Autoplay {
		info += "\n" + style.Emotes.Autoplay + " Autoplay on"
	}
	children = append(children, discordgo.TextDisplay{Content: info})

	pauseLabel, pauseEmoji := "Pause", "⏸"
	if paused {
		pauseLabel, pauseEmoji = "Resume", "▶️"
	}
	children = append(children, discordgo.ActionsRow{Components: []discordgo.MessageComponent{
		discordgo.Button{CustomID: npCtlPrefix + "pause", Label: pauseLabel, Emoji: &discordgo.ComponentEmoji{Name: pauseEmoji}, Style: discordgo.SecondaryButton},
		discordgo.Button{CustomID: npCtlPrefix + "skip", Label: "Skip", Emoji: &discordgo.ComponentEmoji{Name: "⏭"}, Style: discordgo.SecondaryButton},
		discordgo.Button{CustomID: npCtlPrefix + "stop", Label: "Stop", Emoji: &discordgo.ComponentEmoji{Name: "⏹"}, Style: discordgo.DangerButton},
	}})

	accent := style.ColorBrand
	return []discordgo.MessageComponent{discordgo.Container{AccentColor: &accent, Components: children}}, true
}

func NowPlaying(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{Name: "nowplaying", Description: "Show the currently playing track with progress"},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			card, ok := renderNowPlayingCard(d, i.GuildID)
			if !ok {
				return Respond(s, i, style.ErrorEmbed("Nothing is currently playing."))
			}
			_, err := RespondV2(s, i, card)
			return err
		},
		Components: map[string]Handler{
			npCtlPrefix: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
				action := strings.TrimPrefix(i.MessageComponentData().CustomID, npCtlPrefix)
				ephemeral := func(msg string) error {
					return s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
						Type: discordgo.InteractionResponseChannelMessageWithSource,
						Data: &discordgo.InteractionResponseData{Content: msg, Flags: discordgo.MessageFlagsEphemeral},
					})
				}
				if d.Music == nil {
					return ephemeral("Music is currently unavailable.")
				}

				var actionErr error
				switch action {
				case "pause":
					_, actionErr = d.Music.SetPaused(ctx, i.GuildID, !d.Music.Paused(i.GuildID))
				case "skip":
					actionErr = d.Music.Skip(ctx, i.GuildID, displayName(interactionUser(i)))
				case "stop":
					actionErr = d.Music.Stop(ctx, i.GuildID, displayName(interactionUser(i)))
				}
				if actionErr != nil {
					return ephemeral("Nothing is currently playing.")
				}

				// Refresh the card in place; when playback ended, close it out.
				card, ok := renderNowPlayingCard(d, i.GuildID)
				if !ok {
					accent := style.ColorBrand
					card = []discordgo.MessageComponent{discordgo.Container{
						AccentColor: &accent,
						Components: []discordgo.MessageComponent{
							discordgo.TextDisplay{Content: "### " + style.Emotes.Stop + " Playback stopped"},
						},
					}}
				}
				return s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
					Type: discordgo.InteractionResponseUpdateMessage,
					Data: &discordgo.InteractionResponseData{Components: card},
				})
			},
		},
	}
}

// Queue is /queue — paginated view with stateless nav buttons.
func Queue(d Deps) *Command {
	const perPage = 10

	render := func(d Deps, s *discordgo.Session, guildID, guildName, requesterID string, page int) (*discordgo.MessageEmbed, []discordgo.MessageComponent, bool) {
		gp := d.Music.Guild(guildID)
		snapshot := gp.Snapshot()
		if snapshot.Current == nil && len(snapshot.Queue) == 0 {
			return nil, nil, false
		}

		totalPages := max(1, (len(snapshot.Queue)+perPage-1)/perPage)
		page = min(max(page, 0), totalPages-1)

		var sb strings.Builder
		sb.WriteString("**__Now Playing:__**\n")
		if snapshot.Current != nil {
			sb.WriteString(fmt.Sprintf("▶️ [%s](%s) `[%s]`\n┗ Requested by: %s\n\n",
				snapshot.Current.Title, snapshot.Current.DisplayURL(), snapshot.Current.FormattedDuration(), snapshot.Current.Requester))
		} else {
			sb.WriteString("Nothing playing\n\n")
		}
		if len(snapshot.Queue) > 0 {
			sb.WriteString("**__Up Next:__**\n")
			start := page * perPage
			for idx := start; idx < min(start+perPage, len(snapshot.Queue)); idx++ {
				t := snapshot.Queue[idx]
				marker := ""
				if t.Encoded == nil {
					marker = " 🔍" // unresolved Spotify track
				}
				sb.WriteString(fmt.Sprintf("`%d.` [%s](%s) `[%s]`%s\n┗ %s\n", idx+1, t.Title, t.DisplayURL(), t.FormattedDuration(), marker, t.Requester))
			}
		} else {
			sb.WriteString("*No more tracks in queue*")
		}

		var totalSeconds int
		for _, t := range snapshot.Queue {
			totalSeconds += int(t.Duration.Seconds())
		}
		if snapshot.Current != nil {
			totalSeconds += int(snapshot.Current.Duration.Seconds())
		}
		duration := fmt.Sprintf("%dm", totalSeconds/60)
		if totalSeconds >= 3600 {
			duration = fmt.Sprintf("%dh %dm", totalSeconds/3600, (totalSeconds%3600)/60)
		}

		embed := &discordgo.MessageEmbed{
			Title:       "📜 Queue for " + guildName,
			Description: sb.String(),
			Color:       style.ColorBrand,
			Footer: &discordgo.MessageEmbedFooter{
				Text: fmt.Sprintf("Page %d/%d • %d song%s • %s total • Loop: %s",
					page+1, totalPages, len(snapshot.Queue), plural(len(snapshot.Queue)), duration, snapshot.RepeatMode),
				IconURL: style.LogoURL,
			},
		}

		var components []discordgo.MessageComponent
		if totalPages > 1 {
			// Stateless nav: target page + owner encoded in the customID.
			btn := func(emoji string, target int, disabled bool) discordgo.Button {
				return discordgo.Button{
					CustomID: fmt.Sprintf("queue_nav:%s:%d", requesterID, target),
					Emoji:    &discordgo.ComponentEmoji{Name: emoji},
					Style:    discordgo.SecondaryButton,
					Disabled: disabled,
				}
			}
			first := btn("⏮️", 0, page == 0)
			prev := btn("◀️", page-1, page == 0)
			next := btn("▶️", page+1, page >= totalPages-1)
			last := btn("⏭️", totalPages-1, page >= totalPages-1)
			// customIDs must be unique per row; disambiguate duplicates.
			first.CustomID += ":f"
			prev.CustomID += ":p"
			next.CustomID += ":n"
			last.CustomID += ":l"
			components = []discordgo.MessageComponent{discordgo.ActionsRow{Components: []discordgo.MessageComponent{first, prev, next, last}}}
		}
		return embed, components, true
	}

	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "queue",
			Description: "Show the current queue",
			Options: []*discordgo.ApplicationCommandOption{{
				Type: discordgo.ApplicationCommandOptionInteger, Name: "page",
				Description: "Page number to view", Required: false,
			}},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if !requireMusic(d, s, i) {
				return nil
			}
			_, opts := subcommand(i)
			page := 0
			if opt, ok := optionMap(opts)["page"]; ok {
				page = int(opt.IntValue()) - 1
			}
			embed, components, ok := render(d, s, i.GuildID, guildName(s, i.GuildID), interactionUser(i).ID, page)
			if !ok {
				return Respond(s, i, style.ErrorEmbed("Queue is empty."))
			}
			_, err := RespondComplex(s, i, []*discordgo.MessageEmbed{embed}, components)
			return err
		},
		Components: map[string]Handler{
			"queue_nav:": func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
				parts := strings.Split(i.MessageComponentData().CustomID, ":")
				if len(parts) < 3 {
					return nil
				}
				ownerID := parts[1]
				page, _ := strconv.Atoi(parts[2])
				clicker := interactionUser(i)
				if clicker.ID != ownerID {
					return s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
						Type: discordgo.InteractionResponseChannelMessageWithSource,
						Data: &discordgo.InteractionResponseData{
							Content: "Only the person who ran the command can use these buttons.",
							Flags:   discordgo.MessageFlagsEphemeral,
						},
					})
				}
				embed, components, ok := render(d, s, i.GuildID, guildName(s, i.GuildID), ownerID, page)
				if !ok {
					embed = style.ErrorEmbed("Queue is empty.")
					components = []discordgo.MessageComponent{}
				}
				return UpdateV2(s, i, []*discordgo.MessageEmbed{embed}, components)
			},
		},
	}
}

// progressBar renders ▰▰▰▱-style segments — reads cleanly at message font
// size, unlike box-drawing characters that only line up inside code spans.
func progressBar(current, total float64, length int) string {
	if total <= 0 {
		return strings.Repeat("▱", length)
	}
	filled := int(min(current/total, 1)*float64(length) + 0.5)
	return strings.Repeat("▰", filled) + strings.Repeat("▱", length-filled)
}

func formatSeconds(total int) string {
	if total <= 0 {
		return "0:00"
	}
	h, m, s := total/3600, (total%3600)/60, total%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%d:%02d", m, s)
}

func orUnknown(s string) string {
	if s == "" {
		return "Unknown Artist"
	}
	return s
}
