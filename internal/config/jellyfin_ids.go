package config

import (
	"fmt"
	"strings"
)

func canonicalJellyfinConfigID(raw string) string {
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

func canonicalJellyfinMap(values map[string]string, envName string) (map[string]string, error) {
	normalized := make(map[string]string, len(values))
	for rawID, value := range values {
		id := canonicalJellyfinConfigID(rawID)
		if previous, exists := normalized[id]; exists && previous != value {
			return nil, fmt.Errorf(
				"config: %s contains conflicting forms of one Jellyfin ID",
				envName,
			)
		}
		normalized[id] = value
	}
	return normalized, nil
}
