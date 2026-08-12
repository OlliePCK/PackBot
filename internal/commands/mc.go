package commands

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/minecraft"
	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
)

const (
	// mcPingTimeout bounds the status query. Slash commands are already
	// deferred, so this only needs to beat Discord's edit window; keep it short
	// so an unreachable server reports "offline" promptly rather than hanging.
	mcPingTimeout = 8 * time.Second

	// mcRCONTimeout bounds a whitelist command.
	mcRCONTimeout = 10 * time.Second

	// maxSampleNames caps how many player names go in the status embed.
	maxSampleNames = 20

	// mcLeaderboardLimit is how many players the leaderboard shows.
	mcLeaderboardLimit = 15
)

// mcUsernameRe matches a valid Minecraft Java username: 3-16 characters of
// letters, digits and underscore.
//
// This is a security control, not cosmetic input tidying. The username is
// interpolated into a console command sent over RCON, which runs with full
// operator authority — anything that isn't strictly a username must never
// reach that string.
var mcUsernameRe = regexp.MustCompile(`^[A-Za-z0-9_]{3,16}$`)

// MC is /mc — Minecraft server status, self-service whitelisting and playtime.
//
// Registered to one guild (MC_GUILD_ID) rather than globally: it is specific
// to the Pack's server and has no meaning elsewhere. Guild-scoped commands
// also propagate instantly instead of taking up to an hour.
func MC(d Deps) *Command {
	return &Command{
		GuildID: d.MCGuildID,
		Def: &discordgo.ApplicationCommand{
			Name:        "mc",
			Description: "Minecraft server status, whitelist and playtime",
			Options: []*discordgo.ApplicationCommandOption{
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "status",
					Description: "Show the Minecraft server's status",
				},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "whitelist",
					Description: "Whitelist yourself on the Minecraft server",
					Options: []*discordgo.ApplicationCommandOption{
						{
							Type:        discordgo.ApplicationCommandOptionString,
							Name:        "player",
							Description: "Your Minecraft username",
							Required:    true,
						},
					},
				},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "unwhitelist",
					Description: "Remove yourself from the Minecraft whitelist",
				},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "leaderboard",
					Description: "Most Minecraft playtime",
				},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "deaths",
					Description: "Who dies the most, and how",
				},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "advancements",
					Description: "Advancement race standings",
				},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "whois",
					Description: "Look up who a Minecraft username belongs to",
					Options: []*discordgo.ApplicationCommandOption{
						{
							Type:        discordgo.ApplicationCommandOptionString,
							Name:        "player",
							Description: "Minecraft username",
							Required:    true,
						},
					},
				},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "admin",
					Description: "Whitelist administration (bot owner only)",
					Options: []*discordgo.ApplicationCommandOption{
						{
							Type:        discordgo.ApplicationCommandOptionString,
							Name:        "action",
							Description: "What to do",
							Required:    true,
							Choices: []*discordgo.ApplicationCommandOptionChoice{
								{Name: "list", Value: "list"},
								{Name: "add", Value: "add"},
								{Name: "remove", Value: "remove"},
							},
						},
						{
							Type:        discordgo.ApplicationCommandOptionString,
							Name:        "player",
							Description: "Minecraft username (required for add and remove)",
						},
					},
				},
				{
					Type:        discordgo.ApplicationCommandOptionSubCommand,
					Name:        "wipe",
					Description: "Destroy the world and start a new season (bot owner only)",
					Options: []*discordgo.ApplicationCommandOption{
						{
							Type:        discordgo.ApplicationCommandOptionString,
							Name:        "confirm",
							Description: "Type PackCraft to confirm - this permanently destroys the world",
							Required:    true,
						},
						{
							Type:        discordgo.ApplicationCommandOptionString,
							Name:        "seed",
							Description: "Seed for the new world (leave blank for random)",
						},
						{
							Type:        discordgo.ApplicationCommandOptionBoolean,
							Name:        "pregen",
							Description: "Pre-generate terrain with Chunky afterwards (default true)",
						},
						{
							Type:        discordgo.ApplicationCommandOptionBoolean,
							Name:        "keep_map",
							Description: "Reuse the existing map - only valid when re-using the same seed",
						},
					},
				},
			},
		},
		Run: func(ctx context.Context, s *discordgo.Session, i *discordgo.InteractionCreate) error {
			sub, opts := subcommand(i)
			switch sub {
			case "whitelist":
				return mcSelfWhitelist(ctx, d, s, i, opts)
			case "unwhitelist":
				return mcSelfUnwhitelist(ctx, d, s, i)
			case "leaderboard":
				return mcLeaderboard(ctx, d, s, i)
			case "deaths":
				return mcDeaths(ctx, d, s, i)
			case "advancements":
				return mcAdvancements(ctx, d, s, i)
			case "whois":
				return mcWhois(ctx, d, s, i, opts)
			case "admin":
				return mcAdmin(ctx, d, s, i, opts)
			case "wipe":
				return mcWipe(ctx, d, s, i, opts)
			default:
				return mcStatus(ctx, d, s, i)
			}
		},
	}
}

func mcStatus(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate) error {
	if d.MC == nil {
		return Respond(s, i, style.ErrorEmbed(
			"The Minecraft server isn't configured (`MC_ADDRESS` is unset)."))
	}

	ctx, cancel := context.WithTimeout(ctx, mcPingTimeout)
	defer cancel()

	status, err := d.MC.Ping(ctx)
	if err != nil {
		return Respond(s, i, &discordgo.MessageEmbed{
			Title: "Minecraft",
			Description: fmt.Sprintf("%s | **Offline** — couldn't reach `%s`",
				style.Emotes.Error, d.MC.Addr),
			Color:  style.ColorError,
			Footer: style.Footer(),
		})
	}
	return Respond(s, i, mcStatusEmbed(d.MC.Addr, status, d.MCMapURL))
}

// mcSelfWhitelist lets any member of the guild whitelist themselves.
//
// One Minecraft account per Discord user, enforced by the unique index: that
// is what stops a single member whitelisting an unbounded number of accounts,
// and stops someone claiming a username that is already spoken for.
func mcSelfWhitelist(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate,
	opts []*discordgo.ApplicationCommandInteractionDataOption) error {

	user := interactionUser(i)
	if user == nil || i.GuildID == "" {
		return Respond(s, i, style.ErrorEmbed("This command only works in a server."))
	}
	if d.RCON == nil {
		return Respond(s, i, style.ErrorEmbed("Whitelisting isn't available right now — RCON isn't configured."))
	}

	player := ""
	if o, ok := optionMap(opts)["player"]; ok {
		player = strings.TrimSpace(o.StringValue())
	}
	if !mcUsernameRe.MatchString(player) {
		return Respond(s, i, style.ErrorEmbed(
			"That isn't a valid Minecraft username (3-16 letters, digits or underscores)."))
	}

	previous, err := d.Store.ClaimMinecraftAccount(ctx, i.GuildID, user.ID, player)
	if errors.Is(err, storage.ErrMinecraftNameTaken) {
		return Respond(s, i, style.ErrorEmbed(
			fmt.Sprintf("`%s` has already been claimed by someone else.", player)))
	}
	if err != nil {
		return err
	}

	rctx, cancel := context.WithTimeout(ctx, mcRCONTimeout)
	defer cancel()

	if _, err := d.RCON.Exec(rctx, "whitelist add "+player); err != nil {
		// Don't leave the database claiming a whitelist entry the server never
		// received — release it so the user can retry cleanly.
		_, _ = d.Store.UnlinkMinecraftAccount(ctx, i.GuildID, user.ID)
		msg := "Couldn't reach the Minecraft server, so nothing was changed. Try again shortly."
		if errors.Is(err, minecraft.ErrRCONAuthFailed) {
			msg = "The server rejected the whitelist request. Tell an admin."
		}
		return Respond(s, i, style.ErrorEmbed(msg))
	}

	desc := fmt.Sprintf("%s | `%s` is now whitelisted.", style.Emotes.Success, player)
	if previous != "" {
		// Username changed: drop the old entry so it doesn't linger.
		if _, err := d.RCON.Exec(rctx, "whitelist remove "+previous); err == nil {
			desc += fmt.Sprintf("\nRemoved your previous name `%s`.", previous)
		}
	}
	if d.MC != nil {
		desc += "\nJoin at `" + d.MC.Addr + "`"
	}

	return Respond(s, i, &discordgo.MessageEmbed{
		Title:       "Minecraft",
		Description: desc,
		Color:       style.ColorBrand,
		Footer:      style.Footer(),
	})
}

func mcSelfUnwhitelist(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate) error {
	user := interactionUser(i)
	if user == nil || i.GuildID == "" {
		return Respond(s, i, style.ErrorEmbed("This command only works in a server."))
	}
	if d.RCON == nil {
		return Respond(s, i, style.ErrorEmbed("Whitelisting isn't available right now — RCON isn't configured."))
	}

	account, err := d.Store.MinecraftAccountForUser(ctx, i.GuildID, user.ID)
	if err != nil {
		return err
	}
	if account == nil {
		return Respond(s, i, style.ErrorEmbed("You aren't whitelisted."))
	}

	rctx, cancel := context.WithTimeout(ctx, mcRCONTimeout)
	defer cancel()
	if _, err := d.RCON.Exec(rctx, "whitelist remove "+account.MCUsername); err != nil {
		return Respond(s, i, style.ErrorEmbed(
			"Couldn't reach the Minecraft server, so nothing was changed. Try again shortly."))
	}
	if _, err := d.Store.UnlinkMinecraftAccount(ctx, i.GuildID, user.ID); err != nil {
		return err
	}

	return Respond(s, i, style.BrandEmbed(fmt.Sprintf(
		"%s | `%s` has been removed from the whitelist.", style.Emotes.Success, account.MCUsername)))
}

// mcLeaderboard ranks players by tracked playtime, by in-game name — no
// Discord link required, so players whitelisted by hand still appear.
func mcLeaderboard(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate) error {
	entries, err := d.Store.TopMinecraftPlaytime(ctx, mcLeaderboardLimit)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return Respond(s, i, style.BrandEmbed(
			"No playtime recorded yet — it accrues while people are online."))
	}

	var b strings.Builder
	for idx, e := range entries {
		fmt.Fprintf(&b, "**%d.** `%s` — %s\n", idx+1, e.MCUsername, formatPlaytime(e.TotalSeconds))
	}

	return Respond(s, i, &discordgo.MessageEmbed{
		Title:       "Minecraft playtime",
		Description: b.String(),
		Color:       style.ColorBrand,
		Footer:      style.Footer(),
	})
}

func mcWhois(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate,
	opts []*discordgo.ApplicationCommandInteractionDataOption) error {

	if i.GuildID == "" {
		return Respond(s, i, style.ErrorEmbed("This command only works in a server."))
	}
	player := ""
	if o, ok := optionMap(opts)["player"]; ok {
		player = strings.TrimSpace(o.StringValue())
	}
	if !mcUsernameRe.MatchString(player) {
		return Respond(s, i, style.ErrorEmbed("That isn't a valid Minecraft username."))
	}

	account, err := d.Store.MinecraftAccountByUsername(ctx, i.GuildID, player)
	if err != nil {
		return err
	}
	if account == nil {
		return Respond(s, i, style.ErrorEmbed(
			fmt.Sprintf("`%s` hasn't been claimed by anyone here.", player)))
	}

	return Respond(s, i, &discordgo.MessageEmbed{
		Title:       "Minecraft",
		Description: fmt.Sprintf("`%s` is <@%s>", account.MCUsername, account.UserID),
		Color:       style.ColorBrand,
		Footer:      style.Footer(),
		Fields: []*discordgo.MessageEmbedField{
			{Name: "Whitelisted since", Value: account.LinkedAt.Format("2 Jan 2006"), Inline: true},
		},
	})
}

// mcAdmin is the owner-only escape hatch for entries that aren't the caller's
// own — someone who left the Discord, or a name added by hand.
func mcAdmin(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate,
	opts []*discordgo.ApplicationCommandInteractionDataOption) error {

	user := interactionUser(i)
	if d.AdminUserID == "" || user == nil || user.ID != d.AdminUserID {
		return Respond(s, i, style.ErrorEmbed("That's restricted to the bot owner."))
	}
	if d.RCON == nil {
		return Respond(s, i, style.ErrorEmbed("RCON isn't configured."))
	}

	m := optionMap(opts)
	action := ""
	if o, ok := m["action"]; ok {
		action = o.StringValue()
	}
	player := ""
	if o, ok := m["player"]; ok {
		player = strings.TrimSpace(o.StringValue())
	}

	var command string
	switch action {
	case "list":
		command = "whitelist list"
	case "add", "remove":
		if !mcUsernameRe.MatchString(player) {
			return Respond(s, i, style.ErrorEmbed(
				"That isn't a valid Minecraft username (3-16 letters, digits or underscores)."))
		}
		command = fmt.Sprintf("whitelist %s %s", action, player)
	default:
		return Respond(s, i, style.ErrorEmbed("Unknown action."))
	}

	rctx, cancel := context.WithTimeout(ctx, mcRCONTimeout)
	defer cancel()

	out, err := d.RCON.Exec(rctx, command)
	if err != nil {
		msg := "Couldn't reach the Minecraft server over RCON."
		if errors.Is(err, minecraft.ErrRCONAuthFailed) {
			msg = "RCON rejected the password."
		}
		return Respond(s, i, style.ErrorEmbed(msg))
	}
	if out == "" {
		out = "(no output)"
	}
	return Respond(s, i, &discordgo.MessageEmbed{
		Title:       "Minecraft whitelist",
		Description: fmt.Sprintf("%s | `%s`", style.Emotes.Success, command),
		Color:       style.ColorBrand,
		Footer:      style.Footer(),
		Fields: []*discordgo.MessageEmbedField{
			{Name: "Response", Value: truncate(out, 1000)},
		},
	})
}

// mcStatusEmbed renders a successful ping in PackBot's house style.
func mcStatusEmbed(addr string, st *minecraft.Status, mapURL string) *discordgo.MessageEmbed {
	embed := &discordgo.MessageEmbed{
		Title: "Minecraft",
		Description: fmt.Sprintf("%s | **Online** — `%s`",
			style.Emotes.Success, addr),
		Color:  style.ColorBrand,
		Footer: style.Footer(),
		Fields: []*discordgo.MessageEmbedField{
			{
				Name:   "Players",
				Value:  fmt.Sprintf("%d / %d", st.Players.Online, st.Players.Max),
				Inline: true,
			},
			{
				// Version.Name, not Version.Protocol: with ViaVersion installed
				// the server echoes back the *client's* protocol number so it
				// never looks incompatible, which makes protocol useless here.
				Name:   "Version",
				Value:  fallback(st.Version.Name, "unknown"),
				Inline: true,
			},
			{
				Name:   "Latency",
				Value:  st.Latency.Round(time.Millisecond).String(),
				Inline: true,
			},
		},
	}

	if motd := strings.TrimSpace(st.DescriptionText()); motd != "" {
		embed.Fields = append(embed.Fields, &discordgo.MessageEmbedField{Name: "MOTD", Value: motd})
	}
	if mapURL != "" {
		embed.Fields = append(embed.Fields, &discordgo.MessageEmbedField{Name: "Map", Value: mapURL})
	}
	if names := sampleNames(st); names != "" {
		embed.Fields = append(embed.Fields, &discordgo.MessageEmbedField{Name: "Online now", Value: names})
	}
	return embed
}

// sampleNames formats the player sample, which servers may omit entirely even
// when players are online — so an empty result is not "nobody is playing".
func sampleNames(st *minecraft.Status) string {
	if len(st.Players.Sample) == 0 {
		return ""
	}
	names := make([]string, 0, len(st.Players.Sample))
	for _, p := range st.Players.Sample {
		if n := strings.TrimSpace(p.Name); n != "" {
			names = append(names, n)
		}
		if len(names) == maxSampleNames {
			break
		}
	}
	if len(names) == 0 {
		return ""
	}
	out := strings.Join(names, ", ")
	if remaining := st.Players.Online - len(names); remaining > 0 {
		out += fmt.Sprintf(" (+%d more)", remaining)
	}
	return out
}

func fallback(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

// truncate keeps embed fields inside Discord's 1024-character limit.
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-1] + "…"
}

// mcDeaths ranks players by deaths and shows the most common causes.
func mcDeaths(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate) error {
	players, err := d.Store.TopMinecraftDeaths(ctx, mcLeaderboardLimit)
	if err != nil {
		return err
	}
	if len(players) == 0 {
		return Respond(s, i, style.BrandEmbed("Nobody has died yet. Give it time."))
	}
	causes, err := d.Store.TopMinecraftDeathCauses(ctx, 5)
	if err != nil {
		return err
	}

	var b strings.Builder
	total := 0
	for idx, p := range players {
		total += p.Count
		fmt.Fprintf(&b, "%s `%s` — %s\n", medal(idx), p.Name, fmt.Sprintf("%d death%s", p.Count, plural(p.Count)))
	}

	embed := &discordgo.MessageEmbed{
		Title:       "Minecraft deaths",
		Description: b.String(),
		Color:       style.ColorBrand,
		Footer:      style.Footer(),
	}
	if len(causes) > 0 {
		var c strings.Builder
		for _, cause := range causes {
			fmt.Fprintf(&c, "%s — %d\n", cause.Name, cause.Count)
		}
		embed.Fields = append(embed.Fields, &discordgo.MessageEmbedField{
			Name:  fmt.Sprintf("Most common ways to go (%d total)", total),
			Value: truncate(c.String(), 1000),
		})
	}
	return Respond(s, i, embed)
}

// mcAdvancements shows the race standings: total earned, and how many each
// player got to first.
func mcAdvancements(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate) error {
	totals, err := d.Store.TopMinecraftAdvancements(ctx, mcLeaderboardLimit)
	if err != nil {
		return err
	}
	if len(totals) == 0 {
		return Respond(s, i, style.BrandEmbed("No advancements recorded yet."))
	}
	firsts, err := d.Store.MinecraftFirsts(ctx, mcLeaderboardLimit)
	if err != nil {
		return err
	}

	var b strings.Builder
	for idx, t := range totals {
		fmt.Fprintf(&b, "%s `%s` — %d\n", medal(idx), t.Name, t.Count)
	}

	embed := &discordgo.MessageEmbed{
		Title:       "Advancement race",
		Description: b.String(),
		Color:       style.ColorBrand,
		Footer:      style.Footer(),
	}
	if len(firsts) > 0 {
		var f strings.Builder
		for _, x := range firsts {
			fmt.Fprintf(&f, "`%s` — %s\n", x.Name, fmt.Sprintf("%d first%s", x.Count, plural(x.Count)))
		}
		embed.Fields = append(embed.Fields, &discordgo.MessageEmbedField{
			Name:  "🥇 Got there first",
			Value: truncate(f.String(), 1000),
		})
	}
	return Respond(s, i, embed)
}
