package media

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/style"
)

// ErrCardNotFound means Discord has confirmed that the persisted message no
// longer exists, so recreating it cannot produce a duplicate.
var ErrCardNotFound = errors.New("media: Discord card not found")

type discordMessenger struct {
	session *discordgo.Session
}

func newDiscordMessenger(session *discordgo.Session) *discordMessenger {
	return &discordMessenger{session: session}
}

func (m *discordMessenger) Send(channelID string, view ChannelView) (string, error) {
	message, err := style.SendComponents(m.session, channelID, LiveTVCard(view))
	if err != nil {
		return "", err
	}
	return message.ID, nil
}

func (m *discordMessenger) Edit(channelID, messageID string, view ChannelView) error {
	payload := struct {
		Components []discordgo.MessageComponent `json:"components"`
		Flags      discordgo.MessageFlags       `json:"flags"`
	}{
		Components: LiveTVCard(view),
		Flags:      discordgo.MessageFlagsIsComponentsV2,
	}
	uri := discordgo.EndpointChannelMessage(channelID, messageID)
	body, err := m.session.RequestWithBucketID(
		http.MethodPatch,
		uri,
		payload,
		discordgo.EndpointChannelMessage(channelID, ""),
	)
	if err != nil {
		if isDiscordNotFound(err) {
			return ErrCardNotFound
		}
		return err
	}
	// Validate that Discord returned a message rather than accepting an empty
	// or proxy-generated response.
	var message discordgo.Message
	if err := json.Unmarshal(body, &message); err != nil {
		return err
	}
	return nil
}

func (m *discordMessenger) Delete(channelID, messageID string) error {
	err := m.session.ChannelMessageDelete(channelID, messageID)
	if isDiscordNotFound(err) {
		return nil
	}
	return err
}

func isDiscordNotFound(err error) bool {
	if err == nil {
		return false
	}
	var restErr *discordgo.RESTError
	return errors.As(err, &restErr) &&
		restErr.Response != nil &&
		restErr.Response.StatusCode == http.StatusNotFound
}

// isDefiniteDiscordSendFailure identifies Discord responses that prove the
// create request was rejected and therefore could not have created a message.
// Transport failures, malformed success responses, and 5xx responses remain
// ambiguous and must retain the durable pending claim.
func isDefiniteDiscordSendFailure(err error) bool {
	if err == nil {
		return false
	}
	var rateLimitErr *discordgo.RateLimitError
	if errors.As(err, &rateLimitErr) {
		return true
	}
	var restErr *discordgo.RESTError
	return errors.As(err, &restErr) &&
		restErr.Response != nil &&
		restErr.Response.StatusCode >= http.StatusBadRequest &&
		restErr.Response.StatusCode < http.StatusInternalServerError
}
