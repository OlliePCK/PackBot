package style

import (
	"encoding/json"
	"log/slog"

	"github.com/bwmarrin/discordgo"
)

// Send posts embeds to a channel as a Components-V2 card message. lead, when
// set, becomes a plain text block above the card — V2 messages cannot carry
// `content`, so mention lines (role pings, "new video" links) render there.
// Falls back to a classic embed send if Discord rejects the V2 payload.
//
// Raw REST is used because discordgo's MessageSend marshals a null `embeds`
// field even when unset, which the V2 flag forbids.
func Send(s *discordgo.Session, channelID, lead string, embeds ...*discordgo.MessageEmbed) (*discordgo.Message, error) {
	components := FromEmbeds(embeds...)
	if lead != "" {
		components = append([]discordgo.MessageComponent{discordgo.TextDisplay{Content: lead}}, components...)
	}
	msg, err := SendComponents(s, channelID, components)
	if err == nil {
		return msg, nil
	}
	slog.Warn("V2 send rejected, falling back to embeds", "channel", channelID, "error", err)
	return s.ChannelMessageSendComplex(channelID, &discordgo.MessageSend{
		Content: lead,
		Embeds:  embeds,
	})
}

// SendComponents posts a hand-composed V2 component tree to a channel (no
// embed fallback — callers own the layout).
func SendComponents(s *discordgo.Session, channelID string, components []discordgo.MessageComponent) (*discordgo.Message, error) {
	payload := struct {
		Components []discordgo.MessageComponent `json:"components"`
		Flags      discordgo.MessageFlags       `json:"flags"`
	}{components, discordgo.MessageFlagsIsComponentsV2}

	uri := discordgo.EndpointChannelMessages(channelID)
	body, err := s.RequestWithBucketID("POST", uri, payload, uri)
	if err != nil {
		return nil, err
	}
	var msg discordgo.Message
	if err := json.Unmarshal(body, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

// EditCard rewrites an existing message as a V2 card (used by the poll-expiry
// job to close poll messages). Content and embeds are cleared explicitly —
// required when converting a pre-rollout embed message to V2 in one edit.
// Falls back to a classic embed edit for messages Discord won't convert.
func EditCard(s *discordgo.Session, channelID, messageID string, embeds []*discordgo.MessageEmbed, rows []discordgo.MessageComponent) error {
	payload := struct {
		Content    string                       `json:"content"`
		Embeds     []*discordgo.MessageEmbed    `json:"embeds"`
		Components []discordgo.MessageComponent `json:"components"`
		Flags      discordgo.MessageFlags       `json:"flags"`
	}{
		Content:    "",
		Embeds:     []*discordgo.MessageEmbed{},
		Components: FromEmbedsWithRows(embeds, rows),
		Flags:      discordgo.MessageFlagsIsComponentsV2,
	}

	uri := discordgo.EndpointChannelMessage(channelID, messageID)
	_, err := s.RequestWithBucketID("PATCH", uri, payload, discordgo.EndpointChannelMessage(channelID, ""))
	if err == nil {
		return nil
	}
	slog.Warn("V2 edit rejected, falling back to embeds", "channel", channelID, "error", err)
	_, err = s.ChannelMessageEditComplex(&discordgo.MessageEdit{
		Channel:    channelID,
		ID:         messageID,
		Embeds:     &embeds,
		Components: &rows,
	})
	return err
}
