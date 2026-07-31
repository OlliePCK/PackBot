package minecraft

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
)

// DeathLocation is where a player last died.
type DeathLocation struct {
	X, Y, Z   int
	Dimension string
}

// deathPosRe matches the NBT integer-array form Minecraft returns for
// LastDeathLocation, e.g.
//
//	OlliePCK has the following entity data: {pos: [I; -84, -31, -24], dimension: "minecraft:overworld"}
var (
	deathPosRe = regexp.MustCompile(`pos:\s*\[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\s*\]`)
	deathDimRe = regexp.MustCompile(`dimension:\s*"([^"]+)"`)
)

// ParseDeathLocation extracts coordinates from the console output of
// `data get entity <player> LastDeathLocation`.
//
// Returns ok=false for any response that isn't a location — most commonly
// "No entity was found" when the player logged out after dying, or the
// "found no element" reply when they have never died.
func ParseDeathLocation(out string) (DeathLocation, bool) {
	m := deathPosRe.FindStringSubmatch(out)
	if m == nil {
		return DeathLocation{}, false
	}
	x, err1 := strconv.Atoi(m[1])
	y, err2 := strconv.Atoi(m[2])
	z, err3 := strconv.Atoi(m[3])
	if err1 != nil || err2 != nil || err3 != nil {
		return DeathLocation{}, false
	}

	loc := DeathLocation{X: x, Y: y, Z: z}
	if d := deathDimRe.FindStringSubmatch(out); d != nil {
		loc.Dimension = d[1]
	}
	return loc, true
}

// LastDeathLocation asks the server where a player last died.
//
// Requires the player to be connected: the data lives in their entity NBT, so
// someone who quits immediately after dying cannot be looked up. Safe to call
// on a nil *RCON, which reports not-found rather than erroring.
func (c *RCON) LastDeathLocation(ctx context.Context, player string) (DeathLocation, bool, error) {
	if c == nil {
		return DeathLocation{}, false, nil
	}
	out, err := c.Exec(ctx, fmt.Sprintf("data get entity %s LastDeathLocation", player))
	if err != nil {
		return DeathLocation{}, false, err
	}
	loc, ok := ParseDeathLocation(out)
	return loc, ok, nil
}
