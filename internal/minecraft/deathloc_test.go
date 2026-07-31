package minecraft

import "testing"

func TestParseDeathLocation(t *testing.T) {
	// The exact shape the live server returned during development.
	const real = `OlliePCK has the following entity data: {pos: [I; -84, -31, -24], dimension: "minecraft:overworld"}`

	loc, ok := ParseDeathLocation(real)
	if !ok {
		t.Fatal("failed to parse a known-good response")
	}
	if loc.X != -84 || loc.Y != -31 || loc.Z != -24 {
		t.Errorf("pos = %d,%d,%d want -84,-31,-24", loc.X, loc.Y, loc.Z)
	}
	if loc.Dimension != "minecraft:overworld" {
		t.Errorf("dimension = %q", loc.Dimension)
	}
}

func TestParseDeathLocationVariants(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		x, y, z int
		dim     string
	}{
		{
			"nether", `X has the following entity data: {pos: [I; 12, 70, -3], dimension: "minecraft:the_nether"}`,
			12, 70, -3, "minecraft:the_nether",
		},
		{
			"all positive", `X has the following entity data: {pos: [I; 1000, 320, 2500], dimension: "minecraft:overworld"}`,
			1000, 320, 2500, "minecraft:overworld",
		},
		{
			"no dimension field", `X has the following entity data: {pos: [I; 5, 6, 7]}`,
			5, 6, 7, "",
		},
		{
			"extra whitespace", `X: {pos: [I;  -1,   -2,   -3 ], dimension: "minecraft:the_end"}`,
			-1, -2, -3, "minecraft:the_end",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			loc, ok := ParseDeathLocation(tc.in)
			if !ok {
				t.Fatal("expected a parse")
			}
			if loc.X != tc.x || loc.Y != tc.y || loc.Z != tc.z || loc.Dimension != tc.dim {
				t.Errorf("got %+v, want %d,%d,%d %q", loc, tc.x, tc.y, tc.z, tc.dim)
			}
		})
	}
}

func TestParseDeathLocationRejects(t *testing.T) {
	// Everything the server says when there is no usable location.
	bad := []string{
		"No entity was found",
		"OlliePCK has no element named 'LastDeathLocation'",
		"Found no elements matching LastDeathLocation",
		`X has the following entity data: [-845.69d, 64.5d, 158.69d]`, // Pos, not LastDeathLocation
		"",
		"nonsense",
	}
	for _, in := range bad {
		if loc, ok := ParseDeathLocation(in); ok {
			t.Errorf("ParseDeathLocation(%q) wrongly returned %+v", in, loc)
		}
	}
}

func TestNilRCONLastDeathLocation(t *testing.T) {
	var c *RCON
	if _, ok, err := c.LastDeathLocation(nil, "OlliePCK"); ok || err != nil {
		t.Errorf("nil client = (%v, %v), want (false, nil)", ok, err)
	}
}
