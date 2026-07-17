package api

import (
	"fmt"
	"strings"
	"time"
)

// formatUptime renders "Xd Yh Zm" (or "< 1m"), parity with Node formatUptime.
func formatUptime(d time.Duration) string {
	total := int64(d.Seconds())
	days := total / 86400
	hours := (total % 86400) / 3600
	minutes := (total % 3600) / 60

	var parts []string
	if days > 0 {
		parts = append(parts, fmt.Sprintf("%dd", days))
	}
	if hours > 0 {
		parts = append(parts, fmt.Sprintf("%dh", hours))
	}
	if minutes > 0 {
		parts = append(parts, fmt.Sprintf("%dm", minutes))
	}
	if len(parts) == 0 {
		return "< 1m"
	}
	return strings.Join(parts, " ")
}

// formatAPIPlaytime renders "Xh Ym" or "Ym" — note this differs from the
// command formatter (no day rollover), matching Node's WebAPI.formatPlaytime.
func formatAPIPlaytime(totalSeconds int64) string {
	hours := totalSeconds / 3600
	minutes := (totalSeconds % 3600) / 60
	if hours > 0 {
		return fmt.Sprintf("%dh %dm", hours, minutes)
	}
	return fmt.Sprintf("%dm", minutes)
}
