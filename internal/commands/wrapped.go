package commands

import (
	"context"
	"fmt"
	"strings"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
)

// compatibility computes the shared-artist percentage between two artist
// lists (case-insensitive), parity with the Node /wrapped compare math:
// shared ÷ min(len(a), len(b)) × 100.
func compatibility(artistsA, artistsB []string) (percent int, shared []string) {
	setA := make(map[string]bool, len(artistsA))
	for _, a := range artistsA {
		setA[strings.ToLower(a)] = true
	}
	setB := make(map[string]bool, len(artistsB))
	for _, b := range artistsB {
		setB[strings.ToLower(b)] = true
	}
	for a := range setA {
		if setB[a] {
			shared = append(shared, a)
		}
	}
	minSize := min(len(setA), len(setB))
	if minSize == 0 {
		return 0, shared
	}
	return int(float64(len(shared))/float64(minSize)*100 + 0.5), shared
}

func compatEmoji(percent int) string {
	switch {
	case percent >= 80:
		return "❤️‍🔥"
	case percent >= 60:
		return "💖"
	case percent >= 40:
		return "💛"
	case percent >= 20:
		return "💙"
	default:
		return "💔"
	}
}

// Wrapped is /wrapped — Spotify-Wrapped-style listening stats.
func Wrapped(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "wrapped",
			Description: "View music listening stats",
			Options: []*discordgo.ApplicationCommandOption{
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "me", Description: "Your personal music stats"},
				{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "server", Description: "Server-wide music stats"},
				{
					Type: discordgo.ApplicationCommandOptionSubCommand, Name: "compare",
					Description: "Compare music taste with another user",
					Options: []*discordgo.ApplicationCommandOption{{
						Type: discordgo.ApplicationCommandOptionUser, Name: "user",
						Description: "User to compare with", Required: true,
					}},
				},
			},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			sub, opts := subcommand(i)
			om := optionMap(opts)
			user := interactionUser(i)

			switch sub {
			case "me":
				return wrappedMe(ctx, d, s, i, user)
			case "server":
				return wrappedServer(ctx, d, s, i)
			case "compare":
				other := om["user"].UserValue(s)
				return wrappedCompare(ctx, d, s, i, user, other)
			}
			return fmt.Errorf("unknown wrapped subcommand %q", sub)
		},
	}
}

func trackLines(tracks []storage.TrackPlays) string {
	var lines []string
	for idx, t := range tracks {
		artist := t.Artist
		if artist == "" {
			artist = "Unknown"
		}
		lines = append(lines, fmt.Sprintf("%s **%s** — %s (%d plays)", medal(idx), t.Title, artist, t.PlayCount))
	}
	if len(lines) == 0 {
		return "No data"
	}
	return strings.Join(lines, "\n")
}

func artistLines(artists []storage.ArtistPlays) string {
	var lines []string
	for idx, a := range artists {
		lines = append(lines, fmt.Sprintf("%s **%s** (%d plays)", medal(idx), a.Artist, a.PlayCount))
	}
	if len(lines) == 0 {
		return "No data"
	}
	return strings.Join(lines, "\n")
}

func wrappedMe(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate, user *discordgo.User) error {
	stats, err := d.Store.UserWrappedStats(ctx, i.GuildID, user.ID)
	if err != nil {
		return err
	}
	if stats.TotalTracks == 0 {
		return Respond(s, i, style.ErrorEmbed("No listening data found for you in this server yet!"))
	}

	topTracks, err := d.Store.TopTracks(ctx, i.GuildID, user.ID, 5)
	if err != nil {
		return err
	}
	topArtists, err := d.Store.TopArtists(ctx, i.GuildID, user.ID, 5)
	if err != nil {
		return err
	}
	hour, err := d.Store.FavoriteHour(ctx, i.GuildID, user.ID)
	if err != nil {
		return err
	}

	embed := &discordgo.MessageEmbed{
		Title:     fmt.Sprintf("🎧 %s's Music Wrapped", user.Username),
		Color:     style.ColorBrand,
		Footer:    style.Footer(),
		Thumbnail: &discordgo.MessageEmbedThumbnail{URL: user.AvatarURL("")},
		Fields: []*discordgo.MessageEmbedField{
			{Name: "Total Listening Time", Value: formatPlaytime(stats.TotalSeconds), Inline: true},
			{Name: "Tracks Played", Value: fmt.Sprintf("%d", stats.TotalTracks), Inline: true},
			{Name: "Unique Tracks", Value: fmt.Sprintf("%d", stats.UniqueTracks), Inline: true},
			{Name: "🎵 Top Tracks", Value: trackLines(topTracks)},
			{Name: "🎤 Top Artists", Value: artistLines(topArtists)},
		},
	}
	if hour >= 0 {
		embed.Fields = append(embed.Fields, &discordgo.MessageEmbedField{
			Name: "⏰ Peak Listening Hour", Value: formatHour(hour), Inline: true,
		})
	}
	return Respond(s, i, embed)
}

func wrappedServer(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate) error {
	stats, err := d.Store.GuildWrappedStats(ctx, i.GuildID)
	if err != nil {
		return err
	}
	if stats.TotalTracks == 0 {
		return Respond(s, i, style.ErrorEmbed("No listening data found for this server yet!"))
	}

	topTracks, err := d.Store.TopTracks(ctx, i.GuildID, "", 5)
	if err != nil {
		return err
	}
	listeners, err := d.Store.MusicLeaderboard(ctx, i.GuildID, 5)
	if err != nil {
		return err
	}

	var listenerLines []string
	for idx, l := range listeners {
		listenerLines = append(listenerLines, fmt.Sprintf("%s <@%s> — %s (%d plays)",
			medal(idx), l.UserID, formatPlaytime(l.TotalSeconds), l.PlayCount))
	}
	listenersText := "No data"
	if len(listenerLines) > 0 {
		listenersText = strings.Join(listenerLines, "\n")
	}

	embed := &discordgo.MessageEmbed{
		Title:  fmt.Sprintf("🎧 %s Music Wrapped", guildName(s, i.GuildID)),
		Color:  style.ColorBrand,
		Footer: style.Footer(),
		Fields: []*discordgo.MessageEmbedField{
			{Name: "Total Listening Time", Value: formatPlaytime(stats.TotalSeconds), Inline: true},
			{Name: "Tracks Played", Value: fmt.Sprintf("%d", stats.TotalTracks), Inline: true},
			{Name: "Unique Artists", Value: fmt.Sprintf("%d", stats.UniqueArtists), Inline: true},
			{Name: "🎵 Top Tracks", Value: trackLines(topTracks)},
			{Name: "👑 Top Listeners", Value: listenersText},
		},
	}
	if g, err := s.State.Guild(i.GuildID); err == nil && g.Icon != "" {
		embed.Thumbnail = &discordgo.MessageEmbedThumbnail{URL: g.IconURL("")}
	}
	return Respond(s, i, embed)
}

func wrappedCompare(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate, user, other *discordgo.User) error {
	if other.ID == user.ID {
		return Respond(s, i, style.ErrorEmbed("You can't compare with yourself!"))
	}

	type userData struct {
		stats   *storage.WrappedStats
		tracks  []storage.TrackPlays
		artists []storage.ArtistPlays
	}
	load := func(uid string) (*userData, error) {
		stats, err := d.Store.UserWrappedStats(ctx, i.GuildID, uid)
		if err != nil {
			return nil, err
		}
		tracks, err := d.Store.TopTracks(ctx, i.GuildID, uid, 50)
		if err != nil {
			return nil, err
		}
		artists, err := d.Store.TopArtists(ctx, i.GuildID, uid, 30)
		if err != nil {
			return nil, err
		}
		return &userData{stats: stats, tracks: tracks, artists: artists}, nil
	}

	u1, err := load(user.ID)
	if err != nil {
		return err
	}
	u2, err := load(other.ID)
	if err != nil {
		return err
	}
	if u1.stats.TotalTracks == 0 || u2.stats.TotalTracks == 0 {
		return Respond(s, i, style.ErrorEmbed("Both users need listening history to compare."))
	}

	names := func(artists []storage.ArtistPlays) []string {
		out := make([]string, len(artists))
		for idx, a := range artists {
			out[idx] = a.Artist
		}
		return out
	}
	percent, sharedArtists := compatibility(names(u1.artists), names(u2.artists))

	trackKeys := func(tracks []storage.TrackPlays) map[string]bool {
		m := make(map[string]bool, len(tracks))
		for _, t := range tracks {
			m[strings.ToLower(t.Title+"::"+t.Artist)] = true
		}
		return m
	}
	t1, t2 := trackKeys(u1.tracks), trackKeys(u2.tracks)
	sharedTracks := 0
	for k := range t1 {
		if t2[k] {
			sharedTracks++
		}
	}

	sharedText := "None"
	if len(sharedArtists) > 0 {
		show := sharedArtists
		if len(show) > 10 {
			show = show[:10]
		}
		sharedText = strings.Join(show, ", ")
	}

	embed := &discordgo.MessageEmbed{
		Title:       fmt.Sprintf("%s Music Compatibility: %d%%", compatEmoji(percent), percent),
		Description: fmt.Sprintf("**%s** vs **%s**", user.Username, other.Username),
		Color:       style.ColorBrand,
		Footer:      style.Footer(),
		Fields: []*discordgo.MessageEmbedField{
			{Name: user.Username, Value: fmt.Sprintf("%s\n%d plays", formatPlaytime(u1.stats.TotalSeconds), u1.stats.TotalTracks), Inline: true},
			{Name: other.Username, Value: fmt.Sprintf("%s\n%d plays", formatPlaytime(u2.stats.TotalSeconds), u2.stats.TotalTracks), Inline: true},
			{Name: "​", Value: "​", Inline: true},
			{Name: "🎤 Shared Artists", Value: sharedText},
			{Name: "📊 Stats", Value: fmt.Sprintf("**%d** shared artists • **%d** shared tracks", len(sharedArtists), sharedTracks)},
		},
	}
	return Respond(s, i, embed)
}
