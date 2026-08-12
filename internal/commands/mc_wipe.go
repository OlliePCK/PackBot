package commands

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/style"
)

const (
	// mcWipeConfirm is the exact text an owner must type. A button would be one
	// misclick away from destroying a season permanently; typing the server's
	// name cannot happen by accident.
	mcWipeConfirm = "PackCraft"

	// mcWipeTimeout bounds the whole operation. Discord's deferred interaction
	// token expires after 15 minutes, so finish inside that and still leave
	// room to report the outcome.
	mcWipeTimeout = 12 * time.Minute

	// mcWipeStateTimeout bounds one power transition.
	mcWipeStateTimeout = 3 * time.Minute

	// mcWipeBackupTimeout bounds the pre-wipe backup.
	mcWipeBackupTimeout = 6 * time.Minute
)

// mcSeedRe bounds what may be written into server.properties as level-seed.
//
// This is a security control, not input tidying. The seed lands in a key=value
// properties file; a newline in the value would let the caller append arbitrary
// properties — re-enabling RCON on a public bind, disabling the whitelist,
// raising op-permission-level. Only characters that can appear in a real seed
// are allowed through.
var mcSeedRe = regexp.MustCompile(`^-?[A-Za-z0-9_]{1,48}$`)

// mcOnlineRe pulls the player count out of vanilla's /list output:
// "There are 2 of a max of 20 players online: ..."
var mcOnlineRe = regexp.MustCompile(`There are (\d+)`)

// mcWipe destroys the current world and starts a new season.
//
// Ordered so that every irreversible step happens after the reversible ones
// have already succeeded: the backup must complete before the server stops, and
// the server must be fully offline before any file is deleted. A half-finished
// wipe is worse than no wipe, so each stage aborts the whole thing on error and
// says which stage failed.
func mcWipe(ctx context.Context, d Deps, s *discordgo.Session, i *discordgo.InteractionCreate,
	opts []*discordgo.ApplicationCommandInteractionDataOption) error {

	user := interactionUser(i)
	if d.AdminUserID == "" || user == nil || user.ID != d.AdminUserID {
		return Respond(s, i, style.ErrorEmbed("That's restricted to the bot owner."))
	}
	if d.Ptero == nil {
		return Respond(s, i, style.ErrorEmbed(
			"The panel API isn't configured (`PTERO_URL`, `PTERO_API_KEY`, `PTERO_SERVER_ID`)."))
	}
	if d.RCON == nil {
		return Respond(s, i, style.ErrorEmbed("RCON isn't configured."))
	}
	if d.Store == nil {
		return Respond(s, i, style.ErrorEmbed("The database isn't configured."))
	}

	m := optionMap(opts)
	confirm := ""
	if o, ok := m["confirm"]; ok {
		confirm = strings.TrimSpace(o.StringValue())
	}
	if confirm != mcWipeConfirm {
		return Respond(s, i, style.ErrorEmbed(
			"Wipe not confirmed. Re-run with `confirm:"+mcWipeConfirm+
				"` — this permanently destroys the current world."))
	}

	seed := ""
	if o, ok := m["seed"]; ok {
		seed = strings.TrimSpace(o.StringValue())
	}
	if seed != "" && !mcSeedRe.MatchString(seed) {
		return Respond(s, i, style.ErrorEmbed(
			"That isn't a usable seed (letters, digits and underscores, optionally leading `-`)."))
	}

	pregen := true
	if o, ok := m["pregen"]; ok {
		pregen = o.BoolValue()
	}

	ctx, cancel := context.WithTimeout(ctx, mcWipeTimeout)
	defer cancel()

	progress := func(text string) {
		_ = Respond(s, i, style.BrandEmbed(text))
	}

	// Refuse while anyone is connected. A wipe mid-session destroys someone's
	// run without warning, and in hardcore that is not recoverable.
	if online, err := mcOnlinePlayers(ctx, d); err != nil {
		return Respond(s, i, style.ErrorEmbed("Couldn't check who's online: "+err.Error()))
	} else if online > 0 {
		return Respond(s, i, style.ErrorEmbed(fmt.Sprintf(
			"%d player(s) are online. Wait until the server is empty.", online)))
	}

	progress("Backing up before anything is destroyed…")
	if _, err := d.RCON.Exec(ctx, "say Server wipe starting - the world is being reset."); err != nil {
		return Respond(s, i, style.ErrorEmbed("RCON announce failed: "+err.Error()))
	}
	if _, err := d.RCON.Exec(ctx, "save-all flush"); err != nil {
		return Respond(s, i, style.ErrorEmbed("save-all flush failed: "+err.Error()))
	}

	backupName := "pre-wipe " + time.Now().Format("2006-01-02 15:04")
	backupID, err := d.Ptero.CreateBackup(ctx, backupName)
	if err != nil {
		return Respond(s, i, style.ErrorEmbed(
			"Backup could not be started, so nothing was wiped: "+err.Error()))
	}
	bctx, bcancel := context.WithTimeout(ctx, mcWipeBackupTimeout)
	err = d.Ptero.WaitForBackup(bctx, backupID)
	bcancel()
	if err != nil {
		return Respond(s, i, style.ErrorEmbed(
			"Backup did not complete, so nothing was wiped: "+err.Error()))
	}

	progress("Backup complete. Stopping the server…")
	if err := d.Ptero.Power(ctx, "stop"); err != nil {
		return Respond(s, i, style.ErrorEmbed("Stop failed: "+err.Error()))
	}
	sctx, scancel := context.WithTimeout(ctx, mcWipeStateTimeout)
	err = d.Ptero.WaitForState(sctx, "offline")
	scancel()
	if err != nil {
		return Respond(s, i, style.ErrorEmbed("Server didn't stop: "+err.Error()))
	}

	// Delete the world's contents but keep datapacks/. The world regenerates
	// exactly as it would from an empty folder, and the 16 Vanilla Tweaks zips
	// never have to be moved out and back.
	progress("Server stopped. Deleting the world…")
	entries, err := d.Ptero.ListFiles(ctx, "/world")
	if err != nil {
		return Respond(s, i, style.ErrorEmbed("Couldn't list the world folder: "+err.Error()))
	}
	var doomed []string
	for _, e := range entries {
		if e.Name == "datapacks" {
			continue
		}
		doomed = append(doomed, e.Name)
	}
	if err := d.Ptero.DeleteFiles(ctx, "/world", doomed); err != nil {
		return Respond(s, i, style.ErrorEmbed("Deleting the world failed: "+err.Error()))
	}

	// server.properties is only safe to edit while stopped — the server
	// rewrites it on shutdown, silently reverting anything changed while up.
	props, err := d.Ptero.ReadFile(ctx, "/server.properties")
	if err != nil {
		return Respond(s, i, style.ErrorEmbed("Couldn't read server.properties: "+err.Error()))
	}
	if err := d.Ptero.WriteFile(ctx, "/server.properties",
		setProperty(props, "level-seed", seed)); err != nil {
		return Respond(s, i, style.ErrorEmbed("Couldn't write server.properties: "+err.Error()))
	}

	progress("World deleted. Starting the server…")
	if err := d.Ptero.Power(ctx, "start"); err != nil {
		return Respond(s, i, style.ErrorEmbed("Start failed: "+err.Error()))
	}
	rctx, rcancel := context.WithTimeout(ctx, mcWipeStateTimeout)
	err = d.Ptero.WaitForState(rctx, "running")
	rcancel()
	if err != nil {
		return Respond(s, i, style.ErrorEmbed("Server didn't come back up: "+err.Error()))
	}

	// "running" means the process is up, not that the world has finished
	// generating and RCON is listening. Retry rather than racing it.
	progress("Server starting. Waiting for it to accept commands…")
	if err := mcWaitForRCON(ctx, d); err != nil {
		return Respond(s, i, style.ErrorEmbed(
			"The server started but never accepted RCON: "+err.Error()))
	}

	// Per-world settings die with the world and have to be re-applied.
	var notes []string
	if _, err := d.RCON.Exec(ctx, "gamerule players_sleeping_percentage 30"); err != nil {
		notes = append(notes, "could not set players_sleeping_percentage")
	}

	season, err := d.Store.RollMinecraftSeason(ctx, true)
	if err != nil {
		notes = append(notes, "season roll failed: "+err.Error())
	}

	if pregen {
		for _, cmd := range []string{
			"chunky world world", "chunky shape square",
			"chunky radius 3000", "chunky start",
		} {
			if _, err := d.RCON.Exec(ctx, cmd); err != nil {
				notes = append(notes, "chunky: "+err.Error())
				break
			}
		}
	}

	seedText := "random"
	if seed != "" {
		seedText = "`" + seed + "`"
	}
	seasonText := "unchanged"
	if season != nil {
		seasonText = fmt.Sprintf("%s (season %d)", season.Name, season.Season)
	}
	fields := []*discordgo.MessageEmbedField{
		{Name: "Seed", Value: seedText, Inline: true},
		{Name: "Season", Value: seasonText, Inline: true},
		{Name: "Backup", Value: backupName, Inline: false},
	}
	if pregen {
		fields = append(fields, &discordgo.MessageEmbedField{
			Name: "Pre-generation", Value: "Chunky running, radius 3000", Inline: false})
	}
	if len(notes) > 0 {
		fields = append(fields, &discordgo.MessageEmbedField{
			Name: "Warnings", Value: strings.Join(notes, "\n"), Inline: false})
	}

	return Respond(s, i, &discordgo.MessageEmbed{
		Title:       "World wiped",
		Description: "A new world has been generated and a new season opened.",
		Color:       style.ColorSuccess,
		Fields:      fields,
		Footer:      style.Footer(),
	})
}

// mcOnlinePlayers asks the server how many players are connected.
func mcOnlinePlayers(ctx context.Context, d Deps) (int, error) {
	lctx, cancel := context.WithTimeout(ctx, mcRCONTimeout)
	defer cancel()

	out, err := d.RCON.Exec(lctx, "list")
	if err != nil {
		return 0, err
	}
	match := mcOnlineRe.FindStringSubmatch(out)
	if match == nil {
		return 0, fmt.Errorf("unexpected /list output: %q", out)
	}
	return strconv.Atoi(match[1])
}

// mcWaitForRCON polls until the server answers, since a "running" power state
// precedes the world being loaded.
func mcWaitForRCON(ctx context.Context, d Deps) error {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		lctx, cancel := context.WithTimeout(ctx, mcRCONTimeout)
		_, err := d.RCON.Exec(lctx, "list")
		cancel()
		if err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// setProperty replaces key's value in a .properties file, appending the line
// when the key is absent. Other lines, comments and ordering are preserved,
// because everything else in server.properties is load-bearing.
func setProperty(content, key, value string) string {
	lines := strings.Split(content, "\n")
	prefix := key + "="
	for idx, line := range lines {
		// Compare against the line with any trailing \r removed so CRLF files
		// are handled, but write back without reintroducing one.
		if strings.HasPrefix(strings.TrimRight(line, "\r"), prefix) {
			lines[idx] = prefix + value
			return strings.Join(lines, "\n")
		}
	}
	return strings.Join(append(lines, prefix+value), "\n")
}
