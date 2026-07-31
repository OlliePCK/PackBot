// Package mcsync keeps the Minecraft whitelist in step with a Discord role.
//
// It exists as its own package because two callers need the same logic: the
// /mc link command (whitelist immediately if the user already has the role)
// and the guild-member-update tracker (whitelist when the role is granted,
// remove it when taken away). Putting it here keeps commands and trackers
// from importing each other.
package mcsync

import (
	"context"
	"fmt"
	"strings"

	"github.com/OlliePCK/packbot/internal/minecraft"
	"github.com/OlliePCK/packbot/internal/storage"
)

// Syncer applies whitelist changes derived from role membership.
type Syncer struct {
	store  *storage.Store
	rcon   *minecraft.RCON
	roleID string
}

// New returns a Syncer, or nil when the feature isn't fully configured —
// callers can hold the nil and still call Apply.
func New(store *storage.Store, rcon *minecraft.RCON, roleID string) *Syncer {
	roleID = strings.TrimSpace(roleID)
	if store == nil || rcon == nil || roleID == "" {
		return nil
	}
	return &Syncer{store: store, rcon: rcon, roleID: roleID}
}

// RoleID is the Discord role that grants whitelist access.
func (s *Syncer) RoleID() string {
	if s == nil {
		return ""
	}
	return s.roleID
}

// HasRole reports whether a member's role list includes the whitelist role.
func (s *Syncer) HasRole(roles []string) bool {
	if s == nil {
		return false
	}
	for _, r := range roles {
		if r == s.roleID {
			return true
		}
	}
	return false
}

// Apply brings the server's whitelist in line with hasRole for one member.
//
// It is idempotent: the stored whitelisted flag is compared first, so repeated
// member-update events (Discord sends them for nickname changes, avatar
// changes and much else) don't re-issue RCON commands. Returns whether an
// actual change was made.
//
// A user with no linked Minecraft account is a no-op — there is nothing to
// whitelist. Safe to call on a nil *Syncer.
func (s *Syncer) Apply(ctx context.Context, guildID, userID string, hasRole bool) (bool, error) {
	if s == nil {
		return false, nil
	}

	account, err := s.store.MinecraftAccountForUser(ctx, guildID, userID)
	if err != nil {
		return false, err
	}
	if account == nil {
		return false, nil
	}
	if account.Whitelisted == hasRole {
		return false, nil
	}

	action := "remove"
	if hasRole {
		action = "add"
	}
	if _, err := s.rcon.Exec(ctx, fmt.Sprintf("whitelist %s %s", action, account.MCUsername)); err != nil {
		return false, fmt.Errorf("mcsync: whitelist %s %s: %w", action, account.MCUsername, err)
	}

	if err := s.store.SetMinecraftWhitelisted(ctx, guildID, userID, hasRole); err != nil {
		// The server was changed but the record wasn't. Report it: the next
		// event will retry, and retrying an idempotent whitelist command is
		// harmless.
		return true, fmt.Errorf("mcsync: record whitelist state: %w", err)
	}
	return true, nil
}
