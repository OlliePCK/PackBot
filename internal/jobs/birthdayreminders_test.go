package jobs

import "testing"

func TestExtractFamousName(t *testing.T) {
	tests := []struct {
		text string
		want string
	}{
		{"1961 – Barack Obama, 44th President of the United States", "Barack Obama"},
		{"1990 — Some Person, actor (died 2020)", "Some Person"},
		{"1985 - Cristiano Ronaldo, Portuguese footballer", "Cristiano Ronaldo"},
		{"1970 – Mononym", "Mononym"},
		{"no year or dash here", ""},
		{"", ""},
	}
	for _, tt := range tests {
		if got := extractFamousName(tt.text); got != tt.want {
			t.Errorf("extractFamousName(%q) = %q, want %q", tt.text, got, tt.want)
		}
	}
}
