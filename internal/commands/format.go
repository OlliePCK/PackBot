package commands

import "fmt"

// formatPlaytime renders seconds the way the Node leaderboard/wrapped did:
// "Xd Yh Zm" past 24 hours, otherwise "Xh Ym".
func formatPlaytime(totalSeconds int64) string {
	hours := totalSeconds / 3600
	minutes := (totalSeconds % 3600) / 60
	if hours >= 24 {
		return fmt.Sprintf("%dd %dh %dm", hours/24, hours%24, minutes)
	}
	return fmt.Sprintf("%dh %dm", hours, minutes)
}

// medal returns the leaderboard rank prefix: medals for the top three,
// "**N.**" beyond.
func medal(index int) string {
	switch index {
	case 0:
		return "🥇"
	case 1:
		return "🥈"
	case 2:
		return "🥉"
	default:
		return fmt.Sprintf("**%d.**", index+1)
	}
}

// formatHour renders an hour of day as "12 AM" / "3 PM" (parity with wrapped).
func formatHour(hour int) string {
	switch {
	case hour == 0:
		return "12 AM"
	case hour == 12:
		return "12 PM"
	case hour < 12:
		return fmt.Sprintf("%d AM", hour)
	default:
		return fmt.Sprintf("%d PM", hour-12)
	}
}

// plural returns "" for 1, "s" otherwise.
func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
