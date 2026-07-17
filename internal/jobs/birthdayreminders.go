package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
)

// birthdayMessages ports birthday-messages.json verbatim — the tone is
// intentional and confirmed.
var birthdayMessages = []string{
	"Happy birthday. Another year of being completely irrelevant. 🪦",
	"Congratulations. You're still the person everyone quietly hopes doesn't show up. 😶",
	"Another year older and nobody's opinion of you has improved. 📉",
	"Happy birthday. Your existence continues to underwhelm everyone who knows you. 😐",
	"You're older now. The disappointment is just more permanent. 🔒",
	"Another year of being the family/friend group's biggest walking regret. 🤢",
	"Happy birthday. Still waiting for literally anyone to be proud of you. 🏳️",
	"Congrats on surviving another year of being this version of yourself. 💀",
	"You're not getting better with age. You're just getting older at being this disappointing. 🥀",
	"Happy birthday. The silence around you gets louder every year. 🔇",
	"Another year closer to everyone realising they don't actually need you around. 🚪",
	"Happy birthday. May this one hurt exactly as much as you deserve. 🗡️",
	"You're officially too old for people to keep giving you the benefit of the doubt. ⏳",
	"Happy birthday. Your best years are already behind you and everyone knows it. 👋",
	"Another year of being the person people apologise for to other people. 😬",
}

// birthdayTimezone matches the Node cron's explicit timezone.
const birthdayTimezone = "Australia/Melbourne"

// famousNameRe extracts the name from zenquotes' "YEAR – Name, description"
// entries (en dash, em dash, or hyphen).
var famousNameRe = regexp.MustCompile(`^\d+\s*[–—-]\s*(.+?)(?:,\s|$)`)

// extractFamousName pulls a person's name out of a zenquotes Births entry.
func extractFamousName(text string) string {
	if m := famousNameRe.FindStringSubmatch(text); m != nil {
		return strings.TrimSpace(m[1])
	}
	// Fallback parity with Node: split on en dash, take name before comma.
	parts := strings.SplitN(text, "–", 2)
	if len(parts) < 2 {
		return ""
	}
	name := strings.SplitN(parts[1], ",", 2)[0]
	return strings.TrimSpace(name)
}

// BirthdayReminders announces birthdays daily at 09:00 Australia/Melbourne
// in each guild's general channel.
func BirthdayReminders(ctx context.Context, s *discordgo.Session, store *storage.Store) {
	log := slog.With("job", "birthdays")

	loc, err := time.LoadLocation(birthdayTimezone)
	if err != nil {
		log.Error("failed to load timezone; birthday reminders disabled", "tz", birthdayTimezone, "error", err)
		return
	}
	log.Info("birthday reminders scheduled", "time", "09:00", "tz", birthdayTimezone)

	for {
		now := time.Now().In(loc)
		next := time.Date(now.Year(), now.Month(), now.Day(), 9, 0, 0, 0, loc)
		if !next.After(now) {
			next = next.AddDate(0, 0, 1)
		}

		select {
		case <-ctx.Done():
			log.Info("birthday reminders stopped")
			return
		case <-time.After(time.Until(next)):
			checkBirthdays(ctx, s, store, log, loc)
		}
	}
}

func checkBirthdays(ctx context.Context, s *discordgo.Session, store *storage.Store, log *slog.Logger, loc *time.Location) {
	now := time.Now().In(loc)
	month, day := int(now.Month()), now.Day()
	log.Info("birthday check", "month", month, "day", day)

	birthdays, err := store.BirthdaysOn(ctx, month, day)
	if err != nil {
		log.Error("birthday query failed", "error", err)
		return
	}
	if len(birthdays) == 0 {
		return
	}

	famous := fetchFamousBirthdays(ctx, month, day, log)

	// Group by channel so shared birthdays land in one message.
	byChannel := make(map[string][]storage.GuildBirthday)
	for _, b := range birthdays {
		byChannel[b.GeneralChannelID] = append(byChannel[b.GeneralChannelID], b)
	}

	for channelID, people := range byChannel {
		message := birthdayMessages[rand.IntN(len(birthdayMessages))]

		mentions := make([]string, len(people))
		names := make([]string, len(people))
		for idx, p := range people {
			mentions[idx] = "<@" + p.UserID + ">"
			names[idx] = "**" + p.Name + "**"
		}

		var description string
		if len(names) == 1 {
			description = fmt.Sprintf("It's %s's birthday today!\n\n*%s*", names[0], message)
		} else {
			description = fmt.Sprintf("It's %s and %s's birthdays today!\n\n*%s*",
				strings.Join(names[:len(names)-1], ", "), names[len(names)-1], message)
		}
		if len(famous) > 0 {
			description += "\n\nAlso born on this day: " + strings.Join(famous, ", ")
		}

		embed := &discordgo.MessageEmbed{
			Title:       "Happy Birthday!",
			Description: description,
			Color:       style.ColorBrand,
			Footer:      style.Footer(),
		}
		_, err := s.ChannelMessageSendComplex(channelID, &discordgo.MessageSend{
			Content: strings.Join(mentions, " "),
			Embeds:  []*discordgo.MessageEmbed{embed},
		})
		if err != nil {
			log.Error("failed to send birthday reminder", "channel", channelID, "error", err)
			continue
		}
		log.Info("sent birthday reminder", "channel", channelID, "count", len(people))
	}
}

// fetchFamousBirthdays returns up to 3 random famous names born on the date,
// from zenquotes; failures degrade to an empty list.
func fetchFamousBirthdays(ctx context.Context, month, day int, log *slog.Logger) []string {
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	url := fmt.Sprintf("https://today.zenquotes.io/api/%d/%d", month, day)
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Warn("failed to fetch famous birthdays", "error", err)
		return nil
	}
	defer res.Body.Close()

	var payload struct {
		Data struct {
			Births []struct {
				Text string `json:"text"`
			} `json:"Births"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		log.Warn("failed to parse famous birthdays", "error", err)
		return nil
	}

	births := payload.Data.Births
	rand.Shuffle(len(births), func(a, b int) { births[a], births[b] = births[b], births[a] })

	var names []string
	for _, b := range births {
		if name := extractFamousName(b.Text); name != "" {
			names = append(names, name)
		}
		if len(names) == 3 {
			break
		}
	}
	return names
}
