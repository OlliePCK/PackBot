package jobs

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/minecraft"
	"github.com/OlliePCK/packbot/internal/storage"
	"github.com/OlliePCK/packbot/internal/style"
)

const (
	// mcLogPollInterval is how often the log is checked. Also the batching
	// window: everything in one poll is posted as a single message, which is
	// what keeps five players earning the same advancement together from
	// becoming five Discord messages.
	mcLogPollInterval = 2 * time.Second

	// mcLogMaxRead bounds a single read. A server that dumps a stack trace
	// shouldn't pull megabytes into memory in one go.
	mcLogMaxRead = 1 << 20

	// mcLogMaxEvents caps how many events go in one message, so a burst can't
	// exceed Discord's embed limits.
	mcLogMaxEvents = 20
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
func MinecraftLog(ctx context.Context, s *discordgo.Session, logPath, channelID string, store *storage.Store) {
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

			var rendered []string
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
				if store != nil {
					switch ev.Kind {
					case minecraft.EventDeath:
						if err := store.RecordMinecraftDeath(ctx, ev.Player, ev.Detail); err != nil {
							log.Error("record death failed", "error", err, "player", ev.Player)
						}
					case minecraft.EventAdvancement:
						if f, err := store.RecordMinecraftAdvancement(ctx, ev.Player, ev.Detail); err != nil {
							log.Error("record advancement failed", "error", err, "player", ev.Player)
						} else {
							first = f
						}
					}
				}

				if text := renderLogEvent(ev, first); text != "" && len(rendered) < mcLogMaxEvents {
					rendered = append(rendered, text)
				}
			}

			if len(rendered) == 0 {
				continue
			}
			if _, err := s.ChannelMessageSendEmbed(channelID, &discordgo.MessageEmbed{
				Description: strings.Join(rendered, "\n"),
				Color:       style.ColorBrand,
				Footer:      style.Footer(),
			}); err != nil {
				log.Error("failed to post minecraft log events", "error", err, "count", len(rendered))
				continue
			}
			log.Info("posted minecraft log events", "count", len(rendered))
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
		return fmt.Sprintf("💀 %s %s", ev.Player, ev.Detail)
	default:
		return ""
	}
}
