const { spawn } = require('child_process');
const SpotifyWebApi = require('spotify-web-api-node');
const Track = require('./Track');
const logger = require('../logger');

class QueryResolver {
    constructor() {
        this.spotifyApi = null;
        if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
            this.spotifyApi = new SpotifyWebApi({
                clientId: process.env.SPOTIFY_CLIENT_ID,
                clientSecret: process.env.SPOTIFY_CLIENT_SECRET
            });
            this.spotifyTokenExpiresAt = 0;
        }
    }

    async ensureSpotifyToken() {
        if (!this.spotifyApi) return;
        if (Date.now() > this.spotifyTokenExpiresAt) {
            try {
                const data = await this.spotifyApi.clientCredentialsGrant();
                this.spotifyApi.setAccessToken(data.body['access_token']);
                this.spotifyTokenExpiresAt = Date.now() + (data.body['expires_in'] * 1000) - 60000;
            } catch (error) {
                logger.error('Failed to refresh Spotify token: ' + error.message);
            }
        }
    }

    async resolve(query, requestedBy) {
        // Check if Spotify URL
        if (query.includes('spotify.com') && this.spotifyApi) {
            return this.handleSpotify(query, requestedBy);
        }
        
        // Check if URL (YouTube/SoundCloud)
        if (/^https?:\/\//.test(query)) {
            return this.handleUrl(query, requestedBy);
        }

        // Search query
        return this.handleSearch(query, requestedBy);
    }

    async handleSpotify(url, requestedBy) {
        await this.ensureSpotifyToken();
        try {
            if (url.includes('/track/')) {
                const id = url.split('/track/')[1].split('?')[0];
                const data = await this.spotifyApi.getTrack(id);
                const track = data.body;
                const searchString = `${track.name} ${track.artists[0].name}`;
                return this.handleSearch(searchString, requestedBy);
            } else if (url.includes('/playlist/')) {
                const id = url.split('/playlist/')[1].split('?')[0];
                
                // Get playlist info first
                const playlistData = await this.spotifyApi.getPlaylist(id, { fields: 'name,images,external_urls,tracks.total' });
                const playlistInfo = {
                    title: playlistData.body.name,
                    thumbnail: playlistData.body.images?.[0]?.url,
                    url: playlistData.body.external_urls?.spotify,
                    count: playlistData.body.tracks.total
                };
                
                // Return a special object that indicates streaming playlist
                return {
                    isStreamingPlaylist: true,
                    playlistInfo,
                    playlistId: id,
                    total: playlistData.body.tracks.total,
                    requestedBy
                };
            } else if (url.includes('/album/')) {
                const id = url.split('/album/')[1].split('?')[0];
                const data = await this.spotifyApi.getAlbum(id);
                const album = data.body;
                
                const result = album.tracks.items.map(t => new Track({
                    title: t.name,
                    url: null,
                    spotifyUrl: t.external_urls?.spotify || (t.id ? `https://open.spotify.com/track/${t.id}` : null),
                    thumbnail: album.images?.[0]?.url,
                    duration: t.duration_ms / 1000,
                    artist: t.artists?.[0]?.name || 'Unknown Artist',
                    requestedBy,
                    searchQuery: `${t.name} ${t.artists?.[0]?.name || ''}`
                }));
                
                result.playlistInfo = {
                    title: album.name,
                    thumbnail: album.images?.[0]?.url,
                    url: album.external_urls?.spotify,
                    count: album.tracks.items.length
                };
                
                return result;
            }
        } catch (e) {
            logger.error('Spotify Error: ' + e.message);
            return [];
        }
        return [];
    }
    
    // Stream Spotify playlist tracks with a callback for each batch
    async *streamSpotifyPlaylist(playlistId, requestedBy) {
        await this.ensureSpotifyToken();
        
        let offset = 0;
        const limit = 100;
        let total = null;
        
        while (total === null || offset < total) {
            const data = await this.spotifyApi.getPlaylistTracks(playlistId, {
                offset,
                limit,
                fields: 'total,items(track(name,artists,album(images),duration_ms,external_urls,id))'
            });
            
            if (total === null) {
                total = data.body.total;
                logger.info(`Fetching ${total} tracks from Spotify playlist...`);
            }
            
            const tracks = data.body.items
                .map(item => item.track)
                .filter(t => t && t.name)
                .map(t => new Track({
                    title: t.name,
                    url: null, // YouTube URL - resolved later
                    spotifyUrl: t.external_urls?.spotify || (t.id ? `https://open.spotify.com/track/${t.id}` : null),
                    thumbnail: t.album?.images?.[0]?.url,
                    duration: t.duration_ms / 1000,
                    artist: t.artists?.[0]?.name || 'Unknown Artist',
                    requestedBy,
                    searchQuery: `${t.name} ${t.artists?.[0]?.name || ''}`
                }));
            
            offset += limit;
            logger.info(`Fetched ${Math.min(offset, total)}/${total} Spotify tracks`);
            
            yield tracks;
        }
    }

    async handleUrl(url, requestedBy) {
        // First check if it's a playlist with flat mode to get URLs quickly
        const flatInfo = await this.getYtDlpInfo(url, true);
        if (!flatInfo) return [];
        
        if (flatInfo._type === 'playlist' && flatInfo.entries) {
            // Store playlist metadata for the response
            const tracks = flatInfo.entries.map(entry => new Track({
                title: entry.title && entry.title !== entry.id ? entry.title : 'Loading...',
                url: entry.url || entry.webpage_url,
                thumbnail: entry.thumbnail || entry.thumbnails?.[0]?.url,
                duration: entry.duration,
                artist: entry.uploader || entry.artist || entry.creator || entry.channel,
                requestedBy,
                needsMetadata: !entry.title || entry.title === entry.id || entry.title === 'Loading...' || !entry.duration
            }));
            
            // Attach playlist info to the result for display purposes
            tracks.playlistInfo = {
                title: flatInfo.title || 'Unknown Playlist',
                thumbnail: flatInfo.thumbnails?.[0]?.url || flatInfo.thumbnail,
                url: flatInfo.webpage_url || url,
                count: flatInfo.entries.length
            };
            
            return tracks;
        }

        // For single tracks, get full metadata
        const info = await this.getYtDlpInfo(url, false);
        if (!info) return [];

        return [new Track({
            title: info.title || info.fulltitle || 'Unknown Title',
            url: info.webpage_url || info.url,
            thumbnail: info.thumbnail || info.thumbnails?.[0]?.url,
            duration: info.duration,
            artist: info.uploader || info.artist || info.creator || info.channel || 'Unknown Artist',
            requestedBy
        })];
    }

    async handleSearch(query, requestedBy) {
        // Prefer official audio by searching YouTube Music first, fallback to regular YouTube
        // Adding "audio" helps avoid music video results
        const searchQuery = query.toLowerCase().includes('audio') ? query : `${query} audio`;
        
        // Get metadata AND direct stream URL in one call for faster playback
        const result = await this.getSearchWithStreamUrl(`ytsearch:${searchQuery}`);
        if (!result) return [];

        const track = new Track({
            title: result.title || 'Unknown Title',
            url: result.webpage_url || result.url,
            thumbnail: result.thumbnail,
            duration: result.duration,
            artist: result.artist || 'Unknown Artist',
            requestedBy
        });
        
        // Attach direct stream URL if we got it
        if (result.directUrl) {
            track.directUrl = result.directUrl;
        }
        
        return [track];
    }
    
    // Combined search that gets metadata + direct stream URL in one call
    getSearchWithStreamUrl(searchQuery) {
        return new Promise((resolve) => {
            const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';
            const { execFile } = require('child_process');
            
            // Use --print to get both JSON metadata and audio URL
            execFile(ytdlpPath, [
                '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
                '--no-warnings',
                '--no-playlist',
                '-j',  // JSON output
                '-g',  // Also print URL
                searchQuery
            ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    logger.error(`Search error: ${error.message}`);
                    resolve(null);
                    return;
                }
                
                try {
                    const lines = stdout.trim().split('\n');
                    // First line is JSON, second is URL
                    const jsonLine = lines.find(l => l.startsWith('{'));
                    const urlLine = lines.find(l => l.startsWith('http') && !l.includes('youtube.com/watch'));
                    
                    if (jsonLine) {
                        const info = JSON.parse(jsonLine);
                        resolve({
                            title: info.title || info.fulltitle,
                            url: info.webpage_url || info.url,
                            webpage_url: info.webpage_url,
                            thumbnail: info.thumbnail || info.thumbnails?.[0]?.url,
                            duration: info.duration,
                            artist: info.uploader || info.artist || info.creator || info.channel,
                            directUrl: urlLine || null
                        });
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    logger.error(`Parse error: ${e.message}`);
                    resolve(null);
                }
            });
        });
    }

    getYtDlpInfo(url, flatPlaylist = false) {
        return new Promise((resolve) => {
            const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';
            const args = [
                '--dump-single-json',
                '--no-warnings',
            ];
            
            // Only use flat-playlist for getting playlist URLs, not for full metadata
            if (flatPlaylist) {
                args.push('--flat-playlist');
            }
            
            args.push(url);
            
            const proc = spawn(ytdlpPath, args);
            let output = '';
            proc.stdout.on('data', d => output += d);
            proc.on('close', code => {
                if (code === 0) {
                    try {
                        resolve(JSON.parse(output));
                    } catch {
                        resolve(null);
                    }
                } else {
                    resolve(null);
                }
            });
        });
    }
    
    // Get direct stream URL for prefetching
    getDirectStreamUrl(url) {
        return new Promise((resolve) => {
            const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';
            const { execFile } = require('child_process');
            execFile(ytdlpPath, [
                '-g',
                '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
                '--no-warnings',
                '--no-playlist',
                url
            ], { timeout: 30000 }, (error, stdout) => {
                if (error) {
                    resolve(null);
                } else {
                    resolve(stdout.trim().split('\n')[0]);
                }
            });
        });
    }
}

module.exports = new QueryResolver();
