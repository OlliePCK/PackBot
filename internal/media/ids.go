package media

import "strings"

// canonicalJellyfinID reconciles Jellyfin's two common item-ID encodings:
// database UUIDs are often uppercase and hyphenated while API DTOs commonly
// use lowercase 32-hex. Synthetic IDs used by tests remain readable.
func canonicalJellyfinID(raw string) string {
	trimmed := strings.TrimSpace(raw)
	compact := strings.ToLower(strings.ReplaceAll(trimmed, "-", ""))
	if len(compact) != 32 {
		return strings.ToLower(trimmed)
	}
	for _, r := range compact {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return strings.ToLower(trimmed)
		}
	}
	return compact
}

// CanonicalJellyfinID exposes the canonical item-ID form for configuration
// and resolver adapters without exposing any Jellyfin credential material.
func CanonicalJellyfinID(raw string) string {
	return canonicalJellyfinID(raw)
}
