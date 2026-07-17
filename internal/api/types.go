package api

import "github.com/OlliePCK/packbot/internal/storage"

// Local aliases keep handler signatures readable.
type (
	storageAPITrack      = storage.APITrack
	storageAPIUserPlays  = storage.APIUserPlays
	storageHourCount     = storage.HourCount
	storageArtistPlays   = storage.ArtistPlays
	storageRecentPlay    = storage.RecentPlay
)

// JSON-shape helpers: Node always returned arrays, never null.

func emptyIfNilTracks(t []storageAPITrack) []storageAPITrack {
	if t == nil {
		return []storageAPITrack{}
	}
	return t
}

func emptyIfNilArtists(a []storageArtistPlays) []storageArtistPlays {
	if a == nil {
		return []storageArtistPlays{}
	}
	return a
}

func emptyIfNilRecent(p []storageRecentPlay) []storageRecentPlay {
	if p == nil {
		return []storageRecentPlay{}
	}
	return p
}

func firstTracks(t []storageAPITrack, n int) []storageAPITrack {
	if len(t) > n {
		return t[:n]
	}
	return t
}

func firstArtists(a []storageArtistPlays, n int) []storageArtistPlays {
	if len(a) > n {
		return a[:n]
	}
	return a
}
