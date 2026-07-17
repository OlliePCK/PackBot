package youtube

import (
	"context"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

// Scored Spotify→YouTube matching, ported from the Node bot's
// utils/youtube.js (see memory: maxResults=1 is dangerous; fetch many
// candidates and score them; view count is the essential tiebreaker).

// Candidate is a search result with the details scoring needs.
type Candidate struct {
	ID              string
	Title           string
	ChannelTitle    string
	DurationSeconds int
	ViewCount       int64
}

var (
	cleanRe    = regexp.MustCompile(`\b(clean|censored|radio\s*edit)\b`)
	mvRe       = regexp.MustCompile(`\bmusic\s*video\b`)
	fanEditRe  = regexp.MustCompile(`\b(slowed|reverb|sped\s*up|bass\s*boost(?:ed)?|8d|nightcore|daycore|chopped|screwed|pitch(?:ed)?(?:\s*(?:up|down))?|cover|instrumental|karaoke)\b`)
	nonWordRe  = regexp.MustCompile(`[^\w\s]`)
	multiWSRe  = regexp.MustCompile(`\s+`)
	isoDurRe   = regexp.MustCompile(`PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?`)
	stopWords  = map[string]bool{"audio": true, "official": true, "video": true, "lyrics": true, "music": true, "feat": true, "ft": true, "featuring": true}
	deaccenter = transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)
)

// LooksClean reports whether a title is marked as a clean/censored version.
func LooksClean(title string) bool {
	return cleanRe.MatchString(strings.ToLower(title))
}

// LooksFanEdit reports whether a title is marked as a fan edit (slowed,
// pitched, cover, etc.).
func LooksFanEdit(title string) bool {
	return fanEditRe.MatchString(strings.ToLower(title))
}

func normalize(s string) string {
	if out, _, err := transform.String(deaccenter, s); err == nil {
		s = out
	}
	s = strings.ToLower(s)
	s = nonWordRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(multiWSRe.ReplaceAllString(s, " "))
}

// ScoreCandidate rates how likely a result is the right match for a query
// with an expected duration — direct port of Node scoreYouTubeResult.
func ScoreCandidate(c Candidate, expectedDuration time.Duration, query string) int {
	score := 0
	channel := strings.ToLower(c.ChannelTitle)
	title := strings.ToLower(c.Title)

	// Official-channel indicators (auto-generated "- Topic" channels best).
	if strings.HasSuffix(channel, "- topic") {
		score += 20
	}
	if strings.Contains(title, "official") {
		score += 10
	}

	// Penalize clean versions, music videos, and fan edits. The clean
	// penalty was -10 in Node; live testing showed clean versions still
	// out-scoring explicit originals, so it now weighs like a fan edit.
	if cleanRe.MatchString(title) {
		score -= 40
	}
	if mvRe.MatchString(title) {
		score -= 15
	}
	if fanEditRe.MatchString(title) {
		score -= 40
	}

	// View count as popularity/legitimacy signal (log scale, capped +20).
	if c.ViewCount > 1000 {
		score += int(math.Min(20, math.Round(math.Log10(float64(c.ViewCount)/1000)*7)))
	}

	// Query-term coverage across title + channel (topic channels omit the
	// artist from the title).
	if query != "" {
		var terms []string
		for _, t := range strings.Fields(normalize(query)) {
			if len(t) > 2 && !stopWords[t] {
				terms = append(terms, t)
			}
		}
		if len(terms) > 0 {
			titleNorm := normalize(title)
			channelNorm := normalize(channel)
			matched := 0
			for _, term := range terms {
				if strings.Contains(titleNorm, term) || strings.Contains(channelNorm, term) {
					matched++
				}
			}
			ratio := float64(matched) / float64(len(terms))
			if ratio >= 0.8 {
				score += 15
			} else if ratio <= 0.5 {
				score -= 25
			}
		}
	}

	// Duration match — the most important signal.
	expected := int(expectedDuration.Seconds())
	if expected > 0 && c.DurationSeconds > 0 {
		diff := c.DurationSeconds - expected
		if diff < 0 {
			diff = -diff
		}
		switch {
		case diff <= 5:
			score += 100
		case diff <= 15:
			score += 80
		case diff <= 30:
			score += 50
		default:
			score += max(0, 40-diff)
		}
		// Much shorter than expected = likely truncated.
		if float64(c.DurationSeconds) < float64(expected)*0.6 {
			score -= 200
		}
	}

	return score
}

// BestMatch runs the scored search: up to 10 candidates with details, best
// score wins. Empty ID when nothing was found.
func (c *Client) BestMatch(ctx context.Context, query string, expectedDuration time.Duration) (*Candidate, error) {
	var search searchResponse
	err := c.get(ctx, "/search", url.Values{
		"part":       {"snippet"},
		"type":       {"video"},
		"maxResults": {"10"},
		"q":          {query},
	}, &search)
	if err != nil {
		return nil, err
	}
	if len(search.Items) == 0 {
		return nil, nil
	}

	ids := make([]string, 0, len(search.Items))
	for _, item := range search.Items {
		if item.ID.VideoID != "" {
			ids = append(ids, item.ID.VideoID)
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}

	candidates, err := c.videoDetails(ctx, ids)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		// Details fetch degraded: fall back to the first search hit.
		return &Candidate{ID: ids[0], Title: search.Items[0].Snippet.Title, ChannelTitle: search.Items[0].Snippet.ChannelTitle}, nil
	}

	best := candidates[0]
	bestScore := ScoreCandidate(best, expectedDuration, query)
	for _, cand := range candidates[1:] {
		if s := ScoreCandidate(cand, expectedDuration, query); s > bestScore {
			best, bestScore = cand, s
		}
	}
	return &best, nil
}

// videoDetails batch-fetches duration + view count for candidate scoring.
func (c *Client) videoDetails(ctx context.Context, ids []string) ([]Candidate, error) {
	var res struct {
		Items []struct {
			ID      string `json:"id"`
			Snippet struct {
				Title        string `json:"title"`
				ChannelTitle string `json:"channelTitle"`
			} `json:"snippet"`
			ContentDetails struct {
				Duration string `json:"duration"`
			} `json:"contentDetails"`
			Statistics struct {
				ViewCount string `json:"viewCount"`
			} `json:"statistics"`
		} `json:"items"`
	}
	err := c.get(ctx, "/videos", url.Values{
		"part": {"snippet,contentDetails,statistics"},
		"id":   {strings.Join(ids, ",")},
	}, &res)
	if err != nil {
		return nil, err
	}

	out := make([]Candidate, 0, len(res.Items))
	for _, item := range res.Items {
		views, _ := strconv.ParseInt(item.Statistics.ViewCount, 10, 64)
		out = append(out, Candidate{
			ID:              item.ID,
			Title:           item.Snippet.Title,
			ChannelTitle:    item.Snippet.ChannelTitle,
			DurationSeconds: parseISODuration(item.ContentDetails.Duration),
			ViewCount:       views,
		})
	}
	return out, nil
}

func parseISODuration(iso string) int {
	m := isoDurRe.FindStringSubmatch(iso)
	if m == nil {
		return 0
	}
	h, _ := strconv.Atoi(m[1])
	mnt, _ := strconv.Atoi(m[2])
	s, _ := strconv.Atoi(m[3])
	return h*3600 + mnt*60 + s
}
