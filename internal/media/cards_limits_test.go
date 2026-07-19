package media

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSafeDiscordTextBoundsUntrustedFields(t *testing.T) {
	got := safeDiscordText(strings.Repeat("x", 200))
	if count := utf8.RuneCountInString(got); count != 100 {
		t.Fatalf("safe text runes = %d, want 100", count)
	}
	if !strings.HasSuffix(got, "\u2026") {
		t.Fatalf("safe text = %q, want ellipsis suffix", got)
	}
}
