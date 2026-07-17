// Package style holds PackBot's shared embed branding: colors, footer, logo
// and emoji. These were config.json in the Node bot; they are static app
// constants, so in Go they live in code.
package style

import "github.com/bwmarrin/discordgo"

// Embed colors (decimal RGB, matching the Node bot's hex values).
const (
	ColorBrand   = 0xff006a // primary pink
	ColorError   = 0xff0000
	ColorSuccess = 0x00ff00
	ColorWarn    = 0xffaa00
)

// LogoURL is the footer icon used on every embed.
const LogoURL = "https://i.imgur.com/wreY4MI.jpg"

// FooterText is the footer text used on every embed.
const FooterText = "The Pack"

// Emotes mirrors config.json's emoji map.
var Emotes = struct {
	Play, Pause, Stop, Skip, Repeat, Autoplay, Shuffle, Filter, Volume, Error, Success string
}{
	Play: "🎵", Pause: "⏸", Stop: "⏹", Skip: "⏭", Repeat: "🔁",
	Autoplay: "🔄", Shuffle: "🔀", Filter: "🔍", Volume: "🔊",
	Error: "❌", Success: "✅",
}

// Footer returns the standard PackBot embed footer.
func Footer() *discordgo.MessageEmbedFooter {
	return &discordgo.MessageEmbedFooter{Text: FooterText, IconURL: LogoURL}
}

// BrandEmbed builds a simple branded embed with a description.
func BrandEmbed(description string) *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Description: description,
		Color:       ColorBrand,
		Footer:      Footer(),
	}
}

// ErrorEmbed builds the standard red error embed ("❌ | message").
func ErrorEmbed(message string) *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Description: Emotes.Error + " | " + message,
		Color:       ColorError,
		Footer:      Footer(),
	}
}
