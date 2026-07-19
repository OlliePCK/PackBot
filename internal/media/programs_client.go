package media

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxProgramsResponseBytes = 8 << 20

// LiveTVProgram is the narrow, read-only EPG model used by media resolvers.
// Provider URLs, playback information, and other Jellyfin item properties are
// deliberately not represented.
type LiveTVProgram struct {
	ID          string
	Name        string
	SeriesName  string
	Overview    string
	ChannelID   string
	ChannelName string
	Start       time.Time
	End         time.Time
	Genres      []string
	Tags        []string
	IsSports    bool
}

// LiveTVProgramsSource allows the resolver to be tested independently of
// Jellyfin. Implementations must treat channelIDs as an allowlist.
type LiveTVProgramsSource interface {
	LiveTVPrograms(
		ctx context.Context,
		channelIDs []string,
		minEndDate time.Time,
		maxStartDate time.Time,
	) ([]LiveTVProgram, error)
}

// JellyfinProgramsClient reads guide entries from GET /LiveTv/Programs.
type JellyfinProgramsClient struct {
	programsURL string
	token       string
	http        *http.Client
}

// NewJellyfinProgramsClient creates a read-only guide client authenticated
// with a Jellyfin API key.
func NewJellyfinProgramsClient(baseURL, token string) (*JellyfinProgramsClient, error) {
	return newJellyfinProgramsClient(baseURL, token, &http.Client{Timeout: 15 * time.Second})
}

func newJellyfinProgramsClient(
	baseURL string,
	token string,
	httpClient *http.Client,
) (*JellyfinProgramsClient, error) {
	baseURL = strings.TrimSpace(baseURL)
	token = strings.TrimSpace(token)
	if baseURL == "" {
		return nil, fmt.Errorf("media: Jellyfin base URL is required")
	}
	if token == "" {
		return nil, fmt.Errorf("media: Jellyfin token is required")
	}
	if strings.ContainsAny(token, "\"\r\n") {
		return nil, fmt.Errorf("media: Jellyfin token contains invalid characters")
	}
	if httpClient == nil {
		return nil, fmt.Errorf("media: HTTP client is required")
	}

	u, err := url.Parse(baseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("media: invalid Jellyfin base URL")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("media: Jellyfin base URL must not contain credentials, query, or fragment")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/LiveTv/Programs"

	return &JellyfinProgramsClient{
		programsURL: u.String(),
		token:       token,
		http:        httpClient,
	}, nil
}

// LiveTVPrograms returns valid guide rows for the requested channels and time
// range. Rows outside the allowlist or with malformed dates are ignored.
func (c *JellyfinProgramsClient) LiveTVPrograms(
	ctx context.Context,
	channelIDs []string,
	minEndDate time.Time,
	maxStartDate time.Time,
) ([]LiveTVProgram, error) {
	normalizedIDs, err := normalizeOrderedChannelIDs(channelIDs)
	if err != nil {
		return nil, err
	}
	if minEndDate.IsZero() || maxStartDate.IsZero() || !minEndDate.Before(maxStartDate) {
		return nil, fmt.Errorf("media: invalid Jellyfin program time range")
	}

	u, err := url.Parse(c.programsURL)
	if err != nil {
		return nil, fmt.Errorf("media: parse Jellyfin programs URL: %w", err)
	}
	query := u.Query()
	query.Set("channelIds", strings.Join(normalizedIDs, ","))
	query.Set("minEndDate", minEndDate.UTC().Format(time.RFC3339Nano))
	query.Set("maxStartDate", maxStartDate.UTC().Format(time.RFC3339Nano))
	query.Set("enableImages", "false")
	query.Set("enableTotalRecordCount", "false")
	query.Set("fields", "Overview,Genres,Tags")
	u.RawQuery = query.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("media: build Jellyfin programs request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", `MediaBrowser Token="`+c.token+`"`)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("media: fetch Jellyfin programs: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("media: fetch Jellyfin programs: status %d", resp.StatusCode)
	}

	var result jellyfinProgramsResult
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxProgramsResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("media: read Jellyfin programs: %w", err)
	}
	if len(body) > maxProgramsResponseBytes {
		return nil, fmt.Errorf("media: Jellyfin programs response exceeds size limit")
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("media: decode Jellyfin programs: %w", err)
	}

	allowed := make(map[string]struct{}, len(normalizedIDs))
	for _, channelID := range normalizedIDs {
		allowed[channelID] = struct{}{}
	}

	programs := make([]LiveTVProgram, 0, len(result.Items))
	for _, row := range result.Items {
		channelID := CanonicalJellyfinID(row.ChannelID)
		if _, ok := allowed[channelID]; !ok {
			continue
		}
		start, startErr := time.Parse(time.RFC3339Nano, strings.TrimSpace(row.StartDate))
		end, endErr := time.Parse(time.RFC3339Nano, strings.TrimSpace(row.EndDate))
		if startErr != nil || endErr != nil || !start.Before(end) {
			continue
		}

		programs = append(programs, LiveTVProgram{
			ID:          CanonicalJellyfinID(row.ID),
			Name:        cleanText(row.Name),
			SeriesName:  cleanText(row.SeriesName),
			Overview:    cleanText(row.Overview),
			ChannelID:   channelID,
			ChannelName: cleanText(row.ChannelName),
			Start:       start,
			End:         end,
			Genres:      cleanStringSlice(row.Genres),
			Tags:        cleanStringSlice(row.Tags),
			IsSports:    row.IsSports,
		})
	}
	return programs, nil
}

func normalizeOrderedChannelIDs(channelIDs []string) ([]string, error) {
	if len(channelIDs) == 0 {
		return nil, fmt.Errorf("media: at least one Jellyfin channel ID is required")
	}

	seen := make(map[string]struct{}, len(channelIDs))
	normalized := make([]string, 0, len(channelIDs))
	for _, raw := range channelIDs {
		channelID := CanonicalJellyfinID(raw)
		if channelID == "" {
			return nil, fmt.Errorf("media: Jellyfin channel IDs must be non-empty")
		}
		if _, exists := seen[channelID]; exists {
			continue
		}
		seen[channelID] = struct{}{}
		normalized = append(normalized, channelID)
	}
	return normalized, nil
}

func cleanStringSlice(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	cleaned := make([]string, 0, len(values))
	for _, value := range values {
		if value = cleanText(value); value != "" {
			cleaned = append(cleaned, value)
		}
	}
	return cleaned
}

type jellyfinProgramsResult struct {
	Items []jellyfinProgram `json:"Items"`
}

type jellyfinProgram struct {
	ID          string   `json:"Id"`
	Name        string   `json:"Name"`
	SeriesName  string   `json:"SeriesName"`
	Overview    string   `json:"Overview"`
	ChannelID   string   `json:"ChannelId"`
	ChannelName string   `json:"ChannelName"`
	StartDate   string   `json:"StartDate"`
	EndDate     string   `json:"EndDate"`
	Genres      []string `json:"Genres"`
	Tags        []string `json:"Tags"`
	IsSports    bool     `json:"IsSports"`
}
