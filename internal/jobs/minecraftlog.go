package jobs

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/minecraft"
	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
)

const (
	// mcLogPollInterval is how often the log is checked. It stays short because
	// the death-location lookup needs the player still connected — batching for
	// Discord is handled separately by mcLogFlushWindow.
	mcLogPollInterval = 2 * time.Second

	// mcLogFlushWindow is how long events accumulate before being posted.
	//
	// Polling every two seconds meant consecutive events almost never landed in
	// the same cycle, so a player joining and earning two advancements produced
	// three separate cards. Holding events briefly turns that back into the one
	// card it should have been.
	mcLogFlushWindow = 12 * time.Second

	// mcLogMaxRead bounds a single read. A server that dumps a stack trace
	// shouldn't pull megabytes into memory in one go.
	mcLogMaxRead = 1 << 20

	// mcLogMaxEvents caps how many events go in one message, so a burst can't
	// exceed Discord's embed limits.
	mcLogMaxEvents = 20

	// mcLogRCONTimeout bounds the death-location lookup. Kept short: it runs
	// inside the poll loop, and a missing position is far better than a
	// stalled tailer.
	mcLogRCONTimeout = 5 * time.Second
)

// Event colours. Everything used to post in brand pink, which gave a death the
// same visual weight as picking up an advancement. The embed's colour is the
// left accent bar in Discord, so it is free signal — the feed becomes scannable
// without being read.
const (
	mcColorJoin        = 0x639922
	mcColorLeave       = 0x888780
	mcColorAdvancement = style.ColorBrand
	mcColorFirst       = 0xBA7517
	mcColorDeath       = 0xE24B4A
)

// logTailer follows an append-only file across rotations.
type logTailer struct {
	path   string
	offset int64
	info   os.FileInfo
	// remainder holds a trailing partial line, so an event split across two
	// reads isn't parsed as two broken halves.
	remainder []byte
}

// readLines returns whole lines appended since the last call.
//
// The first call only records the current end of file: the log already
// contains the whole session's history, and replaying it on startup would
// re-announce every death since the server booted.
func (t *logTailer) readLines() ([]string, error) {
	fi, err := os.Stat(t.path)
	if err != nil {
		return nil, err
	}

	if t.info == nil {
		t.info, t.offset = fi, fi.Size()
		return nil, nil
	}

	// Minecraft rotates latest.log on restart: the old file is gzipped away
	// and a fresh one takes its place. A different file, or one shorter than
	// where we were reading, means start again from the beginning.
	if !os.SameFile(fi, t.info) || fi.Size() < t.offset {
		t.offset = 0
		t.remainder = nil
	}
	t.info = fi

	if fi.Size() == t.offset {
		return nil, nil
	}

	f, err := os.Open(t.path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	if _, err := f.Seek(t.offset, io.SeekStart); err != nil {
		return nil, err
	}

	toRead := fi.Size() - t.offset
	if toRead > mcLogMaxRead {
		toRead = mcLogMaxRead
	}
	buf := make([]byte, toRead)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.ErrUnexpectedEOF {
		return nil, err
	}
	buf = buf[:n]
	t.offset += int64(n)

	data := append(t.remainder, buf...)
	t.remainder = nil

	// Keep any trailing partial line for the next read.
	if idx := bytes.LastIndexByte(data, '\n'); idx < 0 {
		t.remainder = data
		return nil, nil
	} else if idx != len(data)-1 {
		t.remainder = append([]byte(nil), data[idx+1:]...)
		data = data[:idx+1]
	}

	return strings.Split(strings.TrimRight(string(data), "\n"), "\n"), nil
}

// MinecraftLog tails the server log and posts joins, leaves, advancements and
// deaths to channelID.
//
// This supersedes the status job's roster announcements: the log is
// authoritative and immediate, where the status ping is sampled and capped.
func MinecraftLog(ctx context.Context, s *discordgo.Session, logPath, channelID string, store *storage.Store, rcon *minecraft.RCON) {
	log := slog.With("job", "minecraft-log")

	if logPath == "" || channelID == "" {
		log.Warn("minecraft log notifications disabled",
			"hasPath", logPath != "", "hasChannel", channelID != "")
		return
	}
	if _, err := os.Stat(logPath); err != nil {
		log.Error("minecraft log not readable; notifications disabled", "path", logPath, "error", err)
		return
	}

	log.Info("minecraft log tailing started", "path", logPath, "interval", mcLogPollInterval)

	tailer := &logTailer{path: logPath}
	// Deaths are matched from a maintained pattern list against bare console
	// lines, so a name is only believed if we saw it join. That turns a
	// false-positive pattern match into a no-op rather than a wrong post.
	online := make(map[string]struct{})

	ticker := time.NewTicker(mcLogPollInterval)
	defer ticker.Stop()

	var pending []mcCard
	lastFlush := time.Now()

	for {
		select {
		case <-ctx.Done():
			log.Info("minecraft log tailing stopped")
			return
		case <-ticker.C:
			lines, err := tailer.readLines()
			if err != nil {
				log.Error("read minecraft log failed", "error", err)
				continue
			}

			for _, line := range lines {
				ev, ok := minecraft.ParseLogLine(line)
				if !ok {
					continue
				}
				switch ev.Kind {
				case minecraft.EventJoin:
					online[ev.Player] = struct{}{}
				case minecraft.EventLeave:
					delete(online, ev.Player)
				case minecraft.EventDeath:
					if _, ok := online[ev.Player]; !ok {
						continue // not a player we've seen join; ignore
					}
				}
				// Persist before rendering so the leaderboards stay complete
				// even if the Discord post fails.
				first := false
				deathLoc := ""
				if store != nil {
					switch ev.Kind {
					case minecraft.EventDeath:
						// Coordinates come from the player's LastDeathLocation
						// NBT, which needs them still connected — someone who
						// dies and quits immediately is recorded without a
						// position rather than not at all.
						var px, py, pz *int
						dim := ""
						if rcon != nil {
							lctx, cancel := context.WithTimeout(ctx, mcLogRCONTimeout)
							loc, ok, err := rcon.LastDeathLocation(lctx, ev.Player)
							cancel()
							if err != nil {
								log.Warn("death location lookup failed", "error", err, "player", ev.Player)
							} else if ok {
								px, py, pz, dim = &loc.X, &loc.Y, &loc.Z, loc.Dimension
							}
						}
						if err := store.RecordMinecraftDeath(ctx, ev.Player, ev.Detail, px, py, pz, dim); err != nil {
							log.Error("record death failed", "error", err, "player", ev.Player)
						}
						deathLoc = formatDeathLocation(px, py, pz, dim)
					case minecraft.EventAdvancement:
						if f, err := store.RecordMinecraftAdvancement(ctx, ev.Player, ev.Detail); err != nil {
							log.Error("record advancement failed", "error", err, "player", ev.Player)
						} else {
							first = f
						}
					}
				}

				if text := renderLogEvent(ev, first); text != "" {
					pending = append(pending, mcCard{
						kind: ev.Kind, player: ev.Player,
						text: text, first: first, location: deathLoc,
					})
				}
			}

			// Hold events briefly so consecutive ones share a card, but never
			// past the embed limit.
			if len(pending) == 0 {
				continue
			}
			if len(pending) < mcLogMaxEvents && time.Since(lastFlush) < mcLogFlushWindow {
				continue
			}
			for _, embed := range mcLogEmbeds(pending) {
				if _, err := s.ChannelMessageSendEmbed(channelID, embed); err != nil {
					log.Error("failed to post minecraft log events", "error", err)
				}
			}
			log.Info("posted minecraft log events", "count", len(pending))
			pending = pending[:0]
			lastFlush = time.Now()
		}
	}
}

func renderLogEvent(ev minecraft.LogEvent, first bool) string {
	switch ev.Kind {
	case minecraft.EventJoin:
		return fmt.Sprintf("**+** %s joined", ev.Player)
	case minecraft.EventLeave:
		return fmt.Sprintf("**−** %s left", ev.Player)
	case minecraft.EventAdvancement:
		if first {
			return fmt.Sprintf("🥇 **%s** is first to earn **%s**", ev.Player, ev.Detail)
		}
		return fmt.Sprintf("🏆 **%s** earned **%s**", ev.Player, ev.Detail)
	case minecraft.EventDeath:
		return fmt.Sprintf("💀 **%s** %s", ev.Player, ev.Detail)
	default:
		return ""
	}
}

// mcCard is one rendered event waiting to be posted.
type mcCard struct {
	kind     minecraft.EventKind
	player   string
	text     string
	first    bool
	location string
}

// mcSafeName bounds what may be interpolated into the avatar URL. Player names
// come from parsing a log file, so they are untrusted input by the time they
// reach here.
var mcSafeName = regexp.MustCompile(`^[A-Za-z0-9_]{3,16}$`)

// mcLogEmbeds turns buffered events into Discord embeds.
//
// Deaths get a card to themselves: in hardcore a death ends a run, and listing
// it between "joined the game" and an advancement understates it badly.
// Everything else shares one card, coloured by the most notable event in it.
//
// No footer on any of them. The bot's own avatar and name already sit above
// every message, so a branded footer on a one-line join notice doubles the
// card's height to repeat what Discord just said.
func mcLogEmbeds(cards []mcCard) []*discordgo.MessageEmbed {
	var embeds []*discordgo.MessageEmbed
	var routine []mcCard

	for _, c := range cards {
		if c.kind == minecraft.EventDeath {
			desc := c.text
			if c.location != "" {
				desc += "\n" + c.location
			}
			embeds = append(embeds, &discordgo.MessageEmbed{
				Author:      mcAuthor(c.player),
				Description: desc,
				Color:       mcColorDeath,
			})
			continue
		}
		routine = append(routine, c)
	}

	if len(routine) > 0 {
		lines := make([]string, 0, len(routine))
		players := make(map[string]struct{}, len(routine))
		best := routine[0]
		for _, c := range routine {
			lines = append(lines, c.text)
			players[c.player] = struct{}{}
			if mcRank(c) > mcRank(best) {
				best = c
			}
		}
		embed := &discordgo.MessageEmbed{
			Description: strings.Join(lines, "\n"),
			Color:       mcEventColor(best),
		}
		// Attribute the card only when it is unambiguously about one person.
		if len(players) == 1 {
			embed.Author = mcAuthor(routine[0].player)
		}
		embeds = append(embeds, embed)
	}
	return embeds
}

// mcAuthor renders a player as an embed author with their Minecraft head, so a
// card reads as being about a person rather than a log line.
func mcAuthor(player string) *discordgo.MessageEmbedAuthor {
	a := &discordgo.MessageEmbedAuthor{Name: player}
	if mcSafeName.MatchString(player) {
		a.IconURL = "https://mc-heads.net/avatar/" + player + "/64"
	}
	return a
}

// mcRank orders events by how much attention they deserve, so a mixed batch
// takes its colour from the most notable thing in it.
func mcRank(c mcCard) int {
	switch {
	case c.kind == minecraft.EventAdvancement && c.first:
		return 3
	case c.kind == minecraft.EventAdvancement:
		return 2
	case c.kind == minecraft.EventJoin:
		return 1
	default:
		return 0
	}
}

func mcEventColor(c mcCard) int {
	switch {
	case c.kind == minecraft.EventAdvancement && c.first:
		return mcColorFirst
	case c.kind == minecraft.EventAdvancement:
		return mcColorAdvancement
	case c.kind == minecraft.EventJoin:
		return mcColorJoin
	default:
		return mcColorLeave
	}
}

// formatDeathLocation renders coordinates for a death card, empty when the
// position could not be read.
func formatDeathLocation(x, y, z *int, dim string) string {
	if x == nil || y == nil || z == nil {
		return ""
	}
	where := strings.ReplaceAll(strings.TrimPrefix(dim, "minecraft:"), "_", " ")
	if where == "" {
		return fmt.Sprintf("`%d, %d, %d`", *x, *y, *z)
	}
	return fmt.Sprintf("`%d, %d, %d` · %s", *x, *y, *z, where)
}
