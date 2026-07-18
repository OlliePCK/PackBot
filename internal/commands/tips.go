package commands

import (
	"context"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/afl"
	"github.com/OlliePCK/packbot/internal/style"
)

// Tips is /tips — the AFL model's predictions for the current round, on
// demand. Works in any guild; the weekly auto-post and kickoff pings need
// /settings set-afl-channel, but this command doesn't.
func Tips(d Deps) *Command {
	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "tips",
			Description: "AFL model predictions for the current round",
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			if d.AFL == nil {
				return Respond(s, i, style.ErrorEmbed("AFL predictions aren't configured on this bot."))
			}
			matches, err := d.AFL.Predictions(ctx)
			if err != nil {
				return Respond(s, i, style.ErrorEmbed("Couldn't reach the prediction model — try again later."))
			}
			round, roundMatches := afl.CurrentRound(matches, time.Now())
			if round == "" {
				return Respond(s, i, style.ErrorEmbed("No upcoming predictions available (off-season?)."))
			}
			_, err = RespondV2(s, i, d.AFL.RoundCards(round, roundMatches))
			return err
		},
	}
}
