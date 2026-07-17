package commands

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
)

const pollBarLength = 10

// PollVotePrefix is the customID prefix for poll vote buttons ("poll_vote_N").
const PollVotePrefix = "poll_vote_"

// pollResultsText renders the per-option bar chart (parity with Node's
// buildResultsText: █/░ bars, counts, percentages).
func pollResultsText(options []string, votes map[string][]string) string {
	total := 0
	for _, users := range votes {
		total += len(users)
	}

	lines := make([]string, 0, len(options))
	for idx, opt := range options {
		count := len(votes[strconv.Itoa(idx)])
		pct, filled := 0, 0
		if total > 0 {
			pct = int(float64(count)/float64(total)*100 + 0.5)
			filled = int(float64(count)/float64(total)*pollBarLength + 0.5)
		}
		bar := strings.Repeat("█", filled) + strings.Repeat("░", pollBarLength-filled)
		lines = append(lines, fmt.Sprintf("**%d.** %s\n%s %d vote%s (%d%%)", idx+1, opt, bar, count, plural(count), pct))
	}
	return strings.Join(lines, "\n\n")
}

// pollWinners returns the option(s) with the highest non-zero vote count.
func pollWinners(options []string, votes map[string][]string) []string {
	maxVotes := 0
	for idx := range options {
		if c := len(votes[strconv.Itoa(idx)]); c > maxVotes {
			maxVotes = c
		}
	}
	if maxVotes == 0 {
		return nil
	}
	var winners []string
	for idx, opt := range options {
		if len(votes[strconv.Itoa(idx)]) == maxVotes {
			winners = append(winners, opt)
		}
	}
	return winners
}

// pollEmbed builds the live or closed poll embed (parity with Node buildEmbed).
func pollEmbed(question string, options []string, votes map[string][]string, expiresAt time.Time, closed bool) *discordgo.MessageEmbed {
	total := 0
	for _, users := range votes {
		total += len(users)
	}

	embed := &discordgo.MessageEmbed{
		Description: fmt.Sprintf("**%s**\n\n%s", question, pollResultsText(options, votes)),
	}

	if closed {
		embed.Title = "Poll Results"
		embed.Color = style.ColorSuccess
		if winners := pollWinners(options, votes); winners != nil {
			embed.Fields = append(embed.Fields, &discordgo.MessageEmbedField{
				Name: "Winner", Value: strings.Join(winners, ", "), Inline: true,
			})
		}
		embed.Fields = append(embed.Fields, &discordgo.MessageEmbedField{
			Name: "Total Votes", Value: strconv.Itoa(total), Inline: true,
		})
		embed.Footer = &discordgo.MessageEmbedFooter{Text: "Poll closed"}
		embed.Timestamp = time.Now().Format(time.RFC3339)
	} else {
		embed.Title = "Poll"
		embed.Color = style.ColorBrand
		embed.Footer = &discordgo.MessageEmbedFooter{Text: fmt.Sprintf("%d vote%s • Ends", total, plural(total))}
		embed.Timestamp = expiresAt.Format(time.RFC3339)
	}
	return embed
}

// pollButtons builds one row of vote buttons, disabled when closed.
func pollButtons(options []string, closed bool) []discordgo.MessageComponent {
	buttons := make([]discordgo.MessageComponent, 0, len(options))
	for idx, opt := range options {
		label := opt
		if len(label) > 80 {
			label = label[:77] + "..."
		}
		buttons = append(buttons, discordgo.Button{
			CustomID: PollVotePrefix + strconv.Itoa(idx),
			Label:    label,
			Style:    discordgo.PrimaryButton,
			Disabled: closed,
		})
	}
	return []discordgo.MessageComponent{discordgo.ActionsRow{Components: buttons}}
}

// Poll is /poll — button-vote polls with stateful votes (a scope improvement
// over Node, whose in-memory collector lost votes on restart).
func Poll(d Deps) *Command {
	minDuration := float64(1)

	return &Command{
		Def: &discordgo.ApplicationCommand{
			Name:        "poll",
			Description: "Create a quick poll",
			Options: []*discordgo.ApplicationCommandOption{
				{Type: discordgo.ApplicationCommandOptionString, Name: "question", Description: "Poll question", Required: true, MaxLength: 500},
				{Type: discordgo.ApplicationCommandOptionString, Name: "option1", Description: "First option", Required: true, MaxLength: 100},
				{Type: discordgo.ApplicationCommandOptionString, Name: "option2", Description: "Second option", Required: true, MaxLength: 100},
				{Type: discordgo.ApplicationCommandOptionString, Name: "option3", Description: "Third option (optional)", Required: false, MaxLength: 100},
				{Type: discordgo.ApplicationCommandOptionString, Name: "option4", Description: "Fourth option (optional)", Required: false, MaxLength: 100},
				{Type: discordgo.ApplicationCommandOptionInteger, Name: "duration", Description: "Duration in minutes (default 5, max 1440)", Required: false, MinValue: &minDuration, MaxValue: 1440},
			},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			_, opts := subcommand(i)
			om := optionMap(opts)
			user := interactionUser(i)

			question := om["question"].StringValue()
			var options []string
			for _, name := range []string{"option1", "option2", "option3", "option4"} {
				if o, ok := om[name]; ok && o.StringValue() != "" {
					options = append(options, o.StringValue())
				}
			}

			duration := 5
			if o, ok := om["duration"]; ok {
				duration = int(o.IntValue())
			}
			expiresAt := time.Now().Add(time.Duration(duration) * time.Minute)

			votes := make(map[string][]string, len(options))
			for idx := range options {
				votes[strconv.Itoa(idx)] = []string{}
			}

			msg, err := RespondComplex(s, i,
				[]*discordgo.MessageEmbed{pollEmbed(question, options, votes, expiresAt, false)},
				pollButtons(options, false))
			if err != nil {
				return err
			}

			return d.Store.CreatePoll(ctx, &storage.Poll{
				GuildID:   i.GuildID,
				ChannelID: i.ChannelID,
				MessageID: msg.ID,
				Question:  question,
				Options:   options,
				Votes:     votes,
				CreatedBy: user.ID,
				ExpiresAt: expiresAt,
			})
		},
		Components: map[string]Handler{
			PollVotePrefix: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
				customID := i.MessageComponentData().CustomID
				optionIndex, err := strconv.Atoi(strings.TrimPrefix(customID, PollVotePrefix))
				if err != nil {
					return fmt.Errorf("bad poll vote customID %q", customID)
				}
				user := interactionUser(i)

				poll, err := d.Store.CastVote(ctx, i.Message.ID, user.ID, optionIndex)
				if err != nil {
					return err
				}
				if poll == nil {
					// Closed, expired, or unknown poll: tell only the clicker.
					return s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
						Type: discordgo.InteractionResponseChannelMessageWithSource,
						Data: &discordgo.InteractionResponseData{
							Content: "This poll has closed.",
							Flags:   discordgo.MessageFlagsEphemeral,
						},
					})
				}

				embeds := []*discordgo.MessageEmbed{pollEmbed(poll.Question, poll.Options, poll.Votes, poll.ExpiresAt, false)}
				components := pollButtons(poll.Options, false)
				return s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
					Type: discordgo.InteractionResponseUpdateMessage,
					Data: &discordgo.InteractionResponseData{
						Embeds:     embeds,
						Components: components,
					},
				})
			},
		},
	}
}

// ClosedPollMessage renders the final embed + empty components for an expired
// poll (shared with the poll-expiry job).
func ClosedPollMessage(p *storage.Poll) (*discordgo.MessageEmbed, []discordgo.MessageComponent) {
	return pollEmbed(p.Question, p.Options, p.Votes, p.ExpiresAt, true), []discordgo.MessageComponent{}
}
