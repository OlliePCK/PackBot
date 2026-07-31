package trackers

import (
	"context"
	"log/slog"
	"time"

	"github.com/bwmarrin/discordgo"

	"github.com/OlliePCK/packbot/internal/mcsync"
)

// mcWhitelistTimeout bounds one whitelist sync (a database read plus an RCON
// round trip) so a slow server can't pile up goroutines on a busy guild.
const mcWhitelistTimeout = 15 * time.Second

// MinecraftWhitelist keeps the Minecraft whitelist aligned with a Discord role.
//
// Discord emits GuildMemberUpdate for far more than role changes — nickname
// edits, avatar changes, timeouts — and carries only the new member state, not
// the old. Rather than track previous roles, this recomputes the desired state
// and lets mcsync.Apply no-op when nothing actually differs.
type MinecraftWhitelist struct {
	sync *mcsync.Syncer
	log  *slog.Logger
}

// NewMinecraftWhitelist returns a tracker. A nil syncer yields a tracker whose
// handler does nothing, so registration is unconditional at the call site.
func NewMinecraftWhitelist(syncer *mcsync.Syncer) *MinecraftWhitelist {
	return &MinecraftWhitelist{sync: syncer, log: slog.With("tracker", "mcwhitelist")}
}

// HandleGuildMemberUpdate is a discordgo handler.
func (m *MinecraftWhitelist) HandleGuildMemberUpdate(_ *discordgo.Session, e *discordgo.GuildMemberUpdate) {
	if m == nil || m.sync == nil || e == nil || e.Member == nil || e.User == nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), mcWhitelistTimeout)
	defer cancel()

	changed, err := m.sync.Apply(ctx, e.GuildID, e.User.ID, m.sync.HasRole(e.Roles))
	if err != nil {
		m.log.Error("whitelist sync failed", "error", err, "userId", e.User.ID)
		return
	}
	if changed {
		m.log.Info("whitelist synced from role",
			"userId", e.User.ID, "hasRole", m.sync.HasRole(e.Roles))
	}
}
