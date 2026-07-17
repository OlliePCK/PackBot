package music

import (
	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/style"
)

// Emote shorthands used across music embeds.
var (
	emotePlay    = style.Emotes.Play
	emoteStop    = style.Emotes.Stop
	emoteSkip    = style.Emotes.Skip
	emoteRepeat  = style.Emotes.Repeat
	emoteSuccess = style.Emotes.Success
)

func brandTitleEmbed(title, description string) *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title:       title,
		Description: description,
		Color:       style.ColorBrand,
		Footer:      style.Footer(),
	}
}

func errorEmbed(message string) *discordgo.MessageEmbed {
	return style.ErrorEmbed(message)
}
