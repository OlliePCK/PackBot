package media

import "strings"

type phraseRange struct {
	start int
	end   int
}

// containsDistinctTeamPhrases requires a non-overlapping mention of each
// club. This prevents "Sydney" inside "Greater Western Sydney" and
// "Adelaide" inside "Port Adelaide" from satisfying both sides by itself.
func containsDistinctTeamPhrases(normalized string, homeAliases, awayAliases []string) bool {
	words := strings.Fields(normalized)
	homeRanges := teamPhraseRanges(words, homeAliases)
	awayRanges := teamPhraseRanges(words, awayAliases)
	for _, home := range homeRanges {
		for _, away := range awayRanges {
			if home.end <= away.start || away.end <= home.start {
				return true
			}
		}
	}
	return false
}

func teamPhraseRanges(words, aliases []string) []phraseRange {
	seen := make(map[phraseRange]struct{})
	ranges := make([]phraseRange, 0)
	maxWords := 0
	for _, alias := range aliases {
		phrase := strings.Fields(normalizeSearchText(alias))
		if len(phrase) == 0 || len(phrase) > len(words) {
			continue
		}
		for start := 0; start+len(phrase) <= len(words); start++ {
			matched := true
			for offset := range phrase {
				if words[start+offset] != phrase[offset] {
					matched = false
					break
				}
			}
			if !matched {
				continue
			}
			if len(phrase) > maxWords {
				maxWords = len(phrase)
				seen = make(map[phraseRange]struct{})
				ranges = ranges[:0]
			}
			if len(phrase) < maxWords {
				continue
			}
			found := phraseRange{start: start, end: start + len(phrase)}
			if _, duplicate := seen[found]; duplicate {
				continue
			}
			seen[found] = struct{}{}
			ranges = append(ranges, found)
		}
	}
	return ranges
}
