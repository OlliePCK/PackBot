class Track {
    constructor(data) {
        this.title = data.title || 'Unknown Title';
        this.url = data.url;
        this.spotifyUrl = data.spotifyUrl; // Spotify link for display purposes
        this.thumbnail = data.thumbnail;
        this.duration = data.duration || 0;
        this.artist = data.artist || 'Unknown Artist';
        this.requestedBy = data.requestedBy;
        this.searchQuery = data.searchQuery;
        this.needsMetadata = data.needsMetadata || false;
        this.directUrl = data.directUrl; // Direct stream URL for fast playback
    }
    
    // Get the best available URL for display (YouTube > Spotify > none)
    get displayUrl() {
        return this.url || this.spotifyUrl || null;
    }

    get formattedDuration() {
        if (!this.duration) return 'Unknown';
        const minutes = Math.floor(this.duration / 60);
        const seconds = Math.floor(this.duration % 60);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
}

module.exports = Track;
