// Package afl integrates the AFL prediction model (separate Python/CatBoost
// repo, self-hosted on grid) into PackBot: weekly round-preview posts after
// team announcements, pre-kickoff pings, and the /tips command. The bot only
// ever READS the model's dashboard API — the contract is its
// /api/predictions route (data/master/upcoming_predictions.csv as JSON).
package afl

// Team carries per-club presentation: card accent colour and the name of the
// application emoji holding the club logo (uploaded by SyncEmojis).
type Team struct {
	Name   string // canonical Squiggle name, as the model emits it
	Emoji  string // application-emoji name (also the embedded logo filename)
	Accent int    // primary club colour for card accents
}

// Teams is keyed by the exact team strings the model uses (Squiggle names).
var Teams = map[string]Team{
	"Adelaide":                {Name: "Adelaide", Emoji: "afl_adelaide", Accent: 0x002B5C},
	"Brisbane Lions":          {Name: "Brisbane Lions", Emoji: "afl_brisbane", Accent: 0x7C003E},
	"Carlton":                 {Name: "Carlton", Emoji: "afl_carlton", Accent: 0x031A29},
	"Collingwood":             {Name: "Collingwood", Emoji: "afl_collingwood", Accent: 0x000000},
	"Essendon":                {Name: "Essendon", Emoji: "afl_essendon", Accent: 0xCC2031},
	"Fremantle":               {Name: "Fremantle", Emoji: "afl_fremantle", Accent: 0x331C54},
	"Geelong":                 {Name: "Geelong", Emoji: "afl_geelong", Accent: 0x1C3C63},
	"Gold Coast":              {Name: "Gold Coast", Emoji: "afl_goldcoast", Accent: 0xE02112},
	"Greater Western Sydney":  {Name: "Greater Western Sydney", Emoji: "afl_gws", Accent: 0xF15C22},
	"Hawthorn":                {Name: "Hawthorn", Emoji: "afl_hawthorn", Accent: 0x4D2004},
	"Melbourne":               {Name: "Melbourne", Emoji: "afl_melbourne", Accent: 0x0F1131},
	"North Melbourne":         {Name: "North Melbourne", Emoji: "afl_northmelb", Accent: 0x013B9F},
	"Port Adelaide":           {Name: "Port Adelaide", Emoji: "afl_portadelaide", Accent: 0x008AAB},
	"Richmond":                {Name: "Richmond", Emoji: "afl_richmond", Accent: 0xFFD200},
	"St Kilda":                {Name: "St Kilda", Emoji: "afl_stkilda", Accent: 0xED0F05},
	"Sydney":                  {Name: "Sydney", Emoji: "afl_sydney", Accent: 0xE1251B},
	"West Coast":              {Name: "West Coast", Emoji: "afl_westcoast", Accent: 0x003087},
	"Western Bulldogs":        {Name: "Western Bulldogs", Emoji: "afl_bulldogs", Accent: 0x014896},
}
