const { AudioPlayerStatus, createAudioPlayer, createAudioResource, entersState, VoiceConnectionStatus, StreamType, NoSubscriberBehavior } = require('@discordjs/voice');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const logger = require('../logger').child('music');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QueryResolver = require('./QueryResolver');

// Get FFmpeg path - prefer system ffmpeg in Docker, fallback to ffmpeg-static
function getFFmpegPath() {
    // Check for system ffmpeg first (Docker/Linux)
    const systemPaths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
    for (const p of systemPaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    // Fallback to ffmpeg-static (Windows/dev)
    return require('ffmpeg-static');
}

const FFMPEG_PATH = getFFmpegPath();
logger.info(`Using FFmpeg from: ${FFMPEG_PATH}`);

function buildFfmpegHeaderArgs(headers) {
    if (!headers || typeof headers !== 'object') return [];
    let userAgent = null;
    const headerLines = [];
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined || value === null) continue;
        const safeValue = String(value).replace(/[\r\n]+/g, ' ').trim();
        if (!safeValue) continue;
        if (key.toLowerCase() === 'user-agent') {
            userAgent = safeValue;
            continue;
        }
        headerLines.push(`${key}: ${safeValue}`);
    }
    const args = [];
    if (userAgent) {
        args.push('-user_agent', userAgent);
    }
    if (headerLines.length > 0) {
        args.push('-headers', `${headerLines.join('\r\n')}\r\n`);
    }
    return args;
}

function normalizeHeadersForUrl(url, headers) {
    if (!headers || typeof headers !== 'object') headers = {};
    const normalized = {};
    const headerKeys = new Set();
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined || value === null) continue;
        const safeValue = String(value).replace(/[\r\n]+/g, ' ').trim();
        if (!safeValue) continue;
        normalized[key] = safeValue;
        headerKeys.add(key.toLowerCase());
    }
    
    if (url && /googlevideo\.com|youtube\.com/i.test(url)) {
        if (!headerKeys.has('referer')) {
            normalized['Referer'] = 'https://www.youtube.com/';
        }
        if (!headerKeys.has('origin')) {
            normalized['Origin'] = 'https://www.youtube.com';
        }
        if (!headerKeys.has('range')) {
            normalized['Range'] = 'bytes=0-';
        }
    }
    
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function getYtdlpCookieArgs() {
    const cookiePath = resolveYtdlpCookiesPath();
    if (!cookiePath) return [];
    return ['--cookies', cookiePath];
}

let cachedCookiesPath;
let cachedCookiesChecked = false;

function resolveYtdlpCookiesPath() {
    if (cachedCookiesChecked) return cachedCookiesPath;
    
    const envPath = process.env.YTDLP_COOKIES_PATH || process.env.YTDLP_COOKIES_FILE || process.env.YTDLP_COOKIES;
    if (envPath) {
        cachedCookiesPath = envPath;
        cachedCookiesChecked = true;
        return cachedCookiesPath;
    }
    
    const configPath = process.env.YTDLP_CONFIG_PATH ||
        process.env.YTDLP_CONFIG ||
        path.join(os.homedir(), '.config', 'yt-dlp', 'config');
    
    if (fs.existsSync(configPath)) {
        try {
            const content = fs.readFileSync(configPath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                if (trimmed.startsWith('--cookies')) {
                    let value = trimmed.slice('--cookies'.length).trim();
                    if (value.startsWith('=')) {
                        value = value.slice(1).trim();
                    }
                    if (value) {
                        const resolved = path.isAbsolute(value) ? value : path.resolve(path.dirname(configPath), value);
                        cachedCookiesPath = resolved;
                        cachedCookiesChecked = true;
                        return cachedCookiesPath;
                    }
                }
            }
        } catch {
            // Ignore config read errors; fall back to no cookies
        }
    }
    
    cachedCookiesChecked = true;
    cachedCookiesPath = null;
    return cachedCookiesPath;
}

// Track YouTube auth failures to fall back to direct URL
let ytAuthFailureCount = 0;
let lastYtAuthFailure = 0;
const YT_AUTH_FAILURE_THRESHOLD = 2;
const YT_AUTH_FAILURE_RESET_MS = 30 * 60 * 1000; // 30 minutes

function recordYtAuthFailure() {
    ytAuthFailureCount++;
    lastYtAuthFailure = Date.now();
    logger.warn(`YouTube auth failure recorded (${ytAuthFailureCount}/${YT_AUTH_FAILURE_THRESHOLD})`);
}

function resetYtAuthFailures() {
    if (ytAuthFailureCount > 0) {
        logger.info('Resetting YouTube auth failure count');
    }
    ytAuthFailureCount = 0;
}

function shouldPreferYtdlpStreaming(url) {
    if (!url) return false;
    if (process.env.DISABLE_DIRECT_URL === '1' || process.env.DISABLE_DIRECT_URL === 'true') {
        return true;
    }
    const isYouTube = /youtube\.com|youtu\.be/i.test(url);
    if (!isYouTube) return false;
    const cookiePath = resolveYtdlpCookiesPath();
    if (!cookiePath) return false;

    // Reset failure count after timeout
    if (ytAuthFailureCount > 0 && (Date.now() - lastYtAuthFailure) > YT_AUTH_FAILURE_RESET_MS) {
        resetYtAuthFailures();
    }

    // If we've had too many auth failures, skip cookie-based streaming
    if (ytAuthFailureCount >= YT_AUTH_FAILURE_THRESHOLD) {
        logger.info('Skipping yt-dlp streaming due to recent auth failures, using direct URL');
        return false;
    }

    return true;
}

function getYtdlpRuntimeArgs() {
    const args = [];
    const runtime = process.env.YTDLP_JS_RUNTIME || process.env.YTDLP_JS_RUNTIMES || 'node';
    const remoteComponents = process.env.YTDLP_REMOTE_COMPONENTS || 'ejs:github';
    if (runtime) {
        args.push('--js-runtimes', runtime);
    }
    if (remoteComponents) {
        args.push('--remote-components', remoteComponents);
    }
    return args;
}

function getPrefetchBufferBytes() {
    const raw = process.env.YTDLP_PREFETCH_BYTES;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
    }
    return 1024 * 1024; // 1 MiB default buffer
}

function buildYtdlpStreamArgs(url) {
    return [
        '-o', '-',
        '-q',
        '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
        '--no-warnings',
        '--no-playlist',
        '--no-part',           // Don't create .part files
        '--no-mtime',          // Don't set file modification time
        '--buffer-size', '16K',
        ...getYtdlpRuntimeArgs(),
        ...getYtdlpCookieArgs(),
        url
    ];
}

class Subscription extends EventEmitter {
    constructor(voiceConnection) {
        super();
        this.voiceConnection = voiceConnection;
        // Store guildId from connection if available
        this.guildId = voiceConnection.joinConfig?.guildId;
        
        this.audioPlayer = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Play }
        });
        this.queue = [];
        this.history = []; // Track play history for previous command
        this.queueLock = false;
        this.readyLock = false;
        this.currentTrack = null;
        this.repeatMode = 0; // 0: off, 1: song, 2: queue
        this.volume = 100;
        this.filters = []; // Active audio filters
        this.autoplay = false; // Autoplay related songs when queue ends
        this.playbackStartTime = null; // When the current track started playing
        this.prefetchedUrls = new Map(); // Cache for pre-fetched direct stream URLs
        this.prefetchedHeaders = new Map(); // Cache for HTTP headers for direct URLs
        this.prefetchedStreams = new Map(); // Cache for prefetched yt-dlp stream processes
        this._prefetching = new Set(); // Track URLs/queries currently being prefetched
        this._destroying = false; // Flag to prevent events during cleanup
        this._queueUpdateTimer = null;
        this._queueUpdateFirstTs = null;
        this._queueUpdateDebounceMs = 100;
        this._queueUpdateMaxWaitMs = 2000;
        this._manualDisconnect = false;

        this.voiceConnection.on('stateChange', async (_, newState) => {
            if (newState.status === VoiceConnectionStatus.Disconnected) {
                if (this._manualDisconnect) {
                    try {
                        this.voiceConnection.destroy();
                    } catch {
                        // ignore
                    }
                    return;
                }
                if (newState.reason === VoiceConnectionStatus.WebSocketClose && newState.closeCode === 4014) {
                    try {
                        await entersState(this.voiceConnection, VoiceConnectionStatus.Connecting, 5000);
                    } catch {
                        this.voiceConnection.destroy();
                    }
                } else if (this.voiceConnection.rejoinAttempts < 5) {
                    await new Promise((resolve) => setTimeout(resolve, (this.voiceConnection.rejoinAttempts + 1) * 5000));
                    this.voiceConnection.rejoin();
                } else {
                    this.voiceConnection.destroy();
                }
            } else if (newState.status === VoiceConnectionStatus.Destroyed) {
                // Clean up without emitting events (leave command handles its own response)
                this._destroying = true;
                this.queueLock = true;
                this.queue = [];
                this.currentTrack = null;
                this.prefetchedUrls.clear();
                this.prefetchedHeaders.clear();
                this._clearPrefetchedStreams();
                this._clearQueueUpdateTimer();
                this.audioPlayer.stop(true);
                // Clean up voice command listener if active
                if (this.voiceCommandListener) {
                    this.voiceCommandListener.destroy();
                    this.voiceCommandListener = null;
                }
                this.queueLock = false;
            } else if (
                !this.readyLock &&
                (newState.status === VoiceConnectionStatus.Connecting || newState.status === VoiceConnectionStatus.Signalling)
            ) {
                this.readyLock = true;
                try {
                    await entersState(this.voiceConnection, VoiceConnectionStatus.Ready, 20000);
                } catch {
                    if (this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) this.voiceConnection.destroy();
                } finally {
                    this.readyLock = false;
                }
            }
        });

        this.audioPlayer.on('stateChange', (oldState, newState) => {
            logger.debug(`AudioPlayer state change: ${oldState.status} -> ${newState.status}`);
            
            if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
                logger.info(`AudioPlayer went Idle from ${oldState.status} (destroying: ${this._destroying}, stopping: ${this._stopping})`);
                
                // Don't emit events if we're being destroyed or explicitly stopping
                if (this._destroying || this._stopping) return;
                
                // Track finished naturally
                if (this.queue.length === 0 && this.repeatMode === 0) {
                    this.emit('finish');
                }
                this.processQueue();
            }
        });

        this.audioPlayer.on('error', (error) => {
            logger.error(`Audio player error: ${error.message} | Resource: ${error.resource?.metadata?.title || 'unknown'}`);
            this.processQueue();
        });

        this.voiceConnection.subscribe(this.audioPlayer);
    }

    enqueue(track) {
        // Only emit addSong if there's already something playing (i.e., adding to queue, not starting fresh)
        const shouldEmitAddSong = !this._suppressAddSong && (this.currentTrack !== null || this.queue.length > 0);
        this.queue.push(track);
        this.scheduleQueueUpdate();
        if (shouldEmitAddSong) {
            this.emit('addSong', track);
        }
        
        // Prefetch the next track's stream URL for faster playback
        if (this.currentTrack && this.queue.length === 1) {
            this.prefetchTrack(track);
        }
        
        this.processQueue();
    }

    scheduleQueueUpdate(options = {}) {
        if (this._destroying) return;

        const { immediate = false } = options;
        if (immediate) {
            this._flushQueueUpdate();
            return;
        }

        const now = Date.now();
        if (!this._queueUpdateFirstTs) {
            this._queueUpdateFirstTs = now;
        }

        const elapsed = now - this._queueUpdateFirstTs;
        if (elapsed >= this._queueUpdateMaxWaitMs) {
            this._flushQueueUpdate();
            return;
        }

        if (this._queueUpdateTimer) {
            clearTimeout(this._queueUpdateTimer);
        }

        this._queueUpdateTimer = setTimeout(() => this._flushQueueUpdate(), this._queueUpdateDebounceMs);
        if (typeof this._queueUpdateTimer.unref === 'function') {
            this._queueUpdateTimer.unref();
        }
    }

    _flushQueueUpdate() {
        this._clearQueueUpdateTimer();
        this.emit('queueUpdate');
    }

    _clearQueueUpdateTimer() {
        if (this._queueUpdateTimer) {
            clearTimeout(this._queueUpdateTimer);
            this._queueUpdateTimer = null;
        }
        this._queueUpdateFirstTs = null;
    }

    _discardPrefetchedStream(url, reason = null) {
        if (!url) return;
        const entry = this.prefetchedStreams.get(url);
        if (!entry) return;
        entry.killed = true;
        if (entry.stream && !entry.stream.destroyed) {
            entry.stream.destroy();
        }
        if (entry.process && !entry.process.killed) {
            try {
                entry.process.kill('SIGKILL');
            } catch {
                try {
                    entry.process.kill();
                } catch {
                    // ignore
                }
            }
        }
        this.prefetchedStreams.delete(url);
        if (reason) {
            logger.debug(`Discarded prefetched stream for ${url}: ${reason}`);
        }
    }

    _clearPrefetchedStreams() {
        if (!this.prefetchedStreams || this.prefetchedStreams.size === 0) return;
        for (const url of this.prefetchedStreams.keys()) {
            this._discardPrefetchedStream(url);
        }
    }

    _takePrefetchedStream(url) {
        if (!url) return null;
        const entry = this.prefetchedStreams.get(url);
        if (!entry) return null;
        if (entry.ended || entry.errored || entry.stream?.destroyed) {
            this._discardPrefetchedStream(url, 'stale');
            return null;
        }
        this.prefetchedStreams.delete(url);
        return entry;
    }

    async _prefetchYtdlpStream(url, title = '') {
        if (!url) return;
        if (this.prefetchedStreams.has(url)) return;
        const bufferBytes = getPrefetchBufferBytes();
        if (!Number.isFinite(bufferBytes) || bufferBytes <= 0) return;

        const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';
        const args = buildYtdlpStreamArgs(url);
        const prefetchStream = new PassThrough({ highWaterMark: bufferBytes });
        const child = spawn(ytdlpPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        const entry = {
            url,
            process: child,
            stream: prefetchStream,
            startedAt: Date.now(),
            errorOutput: '',
            ended: false,
            errored: false,
            killed: false
        };

        this.prefetchedStreams.set(url, entry);

        child.stdout.pipe(prefetchStream);

        child.stdout.once('data', () => {
            const label = title ? `"${title}"` : url;
            logger.info(`Prefetched yt-dlp stream ready for ${label} after ${Date.now() - entry.startedAt}ms`);
        });

        child.stderr.on('data', (data) => {
            entry.errorOutput += data.toString();
        });

        child.on('error', (err) => {
            entry.errored = true;
            if (!entry.killed) {
                logger.warn(`yt-dlp prefetch error for ${title || url}: ${err.message}`);
            }
            if (this.prefetchedStreams.get(url) === entry) {
                this.prefetchedStreams.delete(url);
            }
            try {
                prefetchStream.destroy(err);
            } catch {
                // ignore
            }
        });

        child.on('close', (code) => {
            entry.ended = true;
            if (!entry.killed && code !== 0 && code !== null) {
                logger.warn(`yt-dlp prefetch exited with code ${code}: ${entry.errorOutput}`);
                // Detect auth failures (403 Forbidden) - only track for YouTube
                const isYouTube = /youtube\.com|youtu\.be/i.test(url);
                if (isYouTube && (entry.errorOutput.includes('403') || entry.errorOutput.includes('Forbidden') ||
                    entry.errorOutput.includes('Sign in to confirm') || entry.errorOutput.includes('Please sign in'))) {
                    recordYtAuthFailure();
                }
            }
            if (this.prefetchedStreams.get(url) === entry) {
                this.prefetchedStreams.delete(url);
            }
        });
    }
    
    // Pre-fetch the direct stream URL to reduce delay when playing
    async prefetchTrack(track) {
        // Create a unique key for this track
        const prefetchKey = track.url || track.searchQuery;
        if (!prefetchKey) return;
        
        // Skip if already prefetching or prefetched
        if (this._prefetching.has(prefetchKey)) return;
        if (track.url && shouldPreferYtdlpStreaming(track.url) && this.prefetchedStreams.has(track.url)) return;
        if (track.url && !shouldPreferYtdlpStreaming(track.url)) {
            if (track.directUrl && track.directHeaders) return;
            if (this.prefetchedUrls.has(track.url)) return;
        }
        
        this._prefetching.add(prefetchKey);
        
        try {
            // For Spotify tracks without URL, resolve via search first
            if (!track.url && track.searchQuery) {
                const resolved = await QueryResolver.handleSearch(track.searchQuery, track.requestedBy);
                if (resolved && resolved.length > 0) {
                    track.url = resolved[0].url;
                    track.directUrl = resolved[0].directUrl;
                    track.directHeaders = resolved[0].directHeaders;
                    track.duration = resolved[0].duration;
                    track.title = track.title || resolved[0].title;
                    track.thumbnail = resolved[0].thumbnail || track.thumbnail;
                    track.artist = track.artist || resolved[0].artist;
                    logger.info(`Pre-resolved Spotify track: ${track.title}`);
                }
            }
            
            // Skip if no URL
            if (!track.url) {
                return;
            }
            
            if (shouldPreferYtdlpStreaming(track.url)) {
                await this._prefetchYtdlpStream(track.url, track.title);
                return;
            }

            // Skip if already has directUrl for direct playback
            if (track.directUrl) {
                return;
            }

            const streamInfo = await QueryResolver.getDirectStreamInfo(track.url);
            if (streamInfo?.directUrl) {
                this.prefetchedUrls.set(track.url, streamInfo.directUrl);
                if (streamInfo.directHeaders) {
                    this.prefetchedHeaders.set(track.url, streamInfo.directHeaders);
                }
                logger.info(`Prefetched stream URL for: ${track.title}`);
            }
        } catch (error) {
            // Prefetch failed, will fall back to normal method
            logger.warn(`Prefetch failed for ${track.title}: ${error.message}`);
        } finally {
            this._prefetching.delete(prefetchKey);
        }
    }

    stop(user = null) {
        this._stopping = true; // Prevent finish event
        this.queueLock = true;
        this.queue = [];
        this.history = [];
        this.currentTrack = null;
        this.prefetchedUrls.clear();
        this.prefetchedHeaders.clear();
        this._clearPrefetchedStreams();
        this.audioPlayer.stop(true);
        this.emit('stop', user);
        this.queueLock = false;
        this._stopping = false;
    }

    skip(user = null) {
        const skipped = this.currentTrack;
        this.audioPlayer.stop();
        this.emit('skip', skipped, user);
    }

    // Play the previous track from history
    async previous() {
        if (this.history.length === 0) {
            throw new Error('No previous track available');
        }
        
        // Put current track back at the front of the queue
        if (this.currentTrack) {
            this.queue.unshift(this.currentTrack);
        }
        
        // Get the previous track from history
        const previousTrack = this.history.pop();
        this.currentTrack = previousTrack;
        
        // Play the previous track
        const resource = await this.createAudioResource(previousTrack.url, previousTrack.directUrl, previousTrack.directHeaders);
        this.audioPlayer.play(resource);
        this.playbackStartTime = Date.now();
        
        // Prefetch the next track in queue
        if (this.queue.length > 0) {
            this.prefetchTrack(this.queue[0]);
        }
        
        this.emit('playSong', previousTrack);
        return previousTrack;
    }

    // Jump to a specific position in the queue
    async jump(index) {
        if (index < 0 || index >= this.queue.length) {
            throw new Error('Invalid queue position');
        }
        
        // Add current track to history
        if (this.currentTrack) {
            this.history.push(this.currentTrack);
            if (this.history.length > 50) this.history.shift();
        }
        
        // Remove the target track from queue and set as current
        const [targetTrack] = this.queue.splice(index, 1);
        this.currentTrack = targetTrack;
        
        // Resolve if needed
        if (!targetTrack.url && targetTrack.searchQuery) {
            const resolved = await QueryResolver.handleSearch(targetTrack.searchQuery, targetTrack.requestedBy);
            if (resolved && resolved.length > 0) {
                targetTrack.url = resolved[0].url;
                targetTrack.directUrl = resolved[0].directUrl;
                targetTrack.directHeaders = resolved[0].directHeaders;
                targetTrack.duration = resolved[0].duration;
                targetTrack.title = targetTrack.title || resolved[0].title;
                targetTrack.thumbnail = resolved[0].thumbnail || targetTrack.thumbnail;
                targetTrack.artist = targetTrack.artist || resolved[0].artist;
            }
        }

        // Fetch full metadata if needed (for playlist items)
        if (targetTrack.needsMetadata && targetTrack.url) {
            logger.info(`Fetching metadata for jump target: ${targetTrack.url}`);
            const fullInfo = await QueryResolver.getYtDlpInfo(targetTrack.url, false);
            if (fullInfo) {
                targetTrack.title = fullInfo.title || fullInfo.fulltitle || targetTrack.title;
                targetTrack.duration = fullInfo.duration || targetTrack.duration;
                targetTrack.thumbnail = fullInfo.thumbnail || fullInfo.thumbnails?.[0]?.url || targetTrack.thumbnail;
                targetTrack.artist = fullInfo.uploader || fullInfo.artist || fullInfo.creator || fullInfo.channel || targetTrack.artist;
                targetTrack.needsMetadata = false;
            }
        }

        // Play the target track
        const resource = await this.createAudioResource(targetTrack.url, targetTrack.directUrl, targetTrack.directHeaders);
        this.audioPlayer.play(resource);
        this.playbackStartTime = Date.now();
        
        // Prefetch the next track in queue
        if (this.queue.length > 0) {
            this.prefetchTrack(this.queue[0]);
        }
        
        this.emit('playSong', targetTrack);
        return targetTrack;
    }

    // Seek to a specific time in the current track
    async seek(timeSeconds) {
        if (!this.currentTrack || !this.currentTrack.url) {
            throw new Error('No track playing');
        }
        
        const track = this.currentTrack;
        // Always try to get a fresh URL for seeking to avoid expiration issues
        // But fallback to existing directUrl if needed
        let streamInfo = await QueryResolver.getDirectStreamInfo(track.url);
        
        if (!streamInfo) {
            const fallbackUrl = track.directUrl || this.prefetchedUrls.get(track.url);
            const fallbackHeaders = track.directHeaders || this.prefetchedHeaders.get(track.url);
            streamInfo = { directUrl: fallbackUrl, directHeaders: fallbackHeaders };
        }
        
        if (!streamInfo?.directUrl) {
            throw new Error('Could not get stream URL for seek');
        }
        
        // Create new resource with seek position and current filters
        logger.info(`Seeking to ${timeSeconds}s with URL: ${streamInfo.directUrl.substring(0, 50)}...`);
        const resource = await this.createAudioResourceWithFilters(streamInfo.directUrl, timeSeconds, this.filters, streamInfo.directHeaders);
        this.audioPlayer.play(resource);
        
        // Update playback start time to reflect the seek
        // If we seek to 60s, we want (Date.now() - playbackStartTime) / 1000 = 60
        // So playbackStartTime = Date.now() - 60000
        this.playbackStartTime = Date.now() - (timeSeconds * 1000);
        
        logger.info(`Seeked to ${timeSeconds}s in ${track.title}`);
    }
    
    // Create audio resource with a seek offset
    createAudioResourceWithSeek(directUrl, seekSeconds, headers = null) {
        return this.createAudioResourceWithFilters(directUrl, seekSeconds, [], headers);
    }
    
    // Create audio resource with filters and optional seek
    createAudioResourceWithFilters(directUrl, seekSeconds = 0, filters = [], headers = null) {
        return new Promise((resolve, reject) => {
            const ffmpegArgs = [
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5'
            ];

            // Add seek if needed - using input seeking (fast)
            if (seekSeconds > 0) {
                ffmpegArgs.push('-ss', seekSeconds.toString());
            }

            const effectiveHeaders = normalizeHeadersForUrl(directUrl, headers);
            const headerArgs = buildFfmpegHeaderArgs(effectiveHeaders);
            if (headerArgs.length > 0) {
                ffmpegArgs.push(...headerArgs);
            }

            ffmpegArgs.push('-i', directUrl);

            // Add audio filters if any
            if (filters.length > 0) {
                const filterString = filters
                    .map(f => Subscription.FILTER_VALUES[f])
                    .filter(Boolean)
                    .join(',');
                if (filterString) {
                    ffmpegArgs.push('-af', filterString);
                }
            }

            ffmpegArgs.push(
                '-f', 's16le',
                '-ar', '48000',
                '-ac', '2',
                '-loglevel', 'warning',
                'pipe:1'
            );

            logger.debug(`Spawning FFmpeg with args: ${ffmpegArgs.join(' ')}`);
            const child = spawn(FFMPEG_PATH, ffmpegArgs);

            let stderrData = '';
            child.stderr.on('data', (data) => {
                const msg = data.toString();
                stderrData += msg;
                if (msg.includes('Error') || msg.includes('Invalid') || msg.includes('403')) {
                    logger.warn(`FFmpeg stderr: ${msg.trim()}`);
                }
            });

            child.on('error', reject);

            // Handle stdout errors (e.g., broken pipe when skipping)
            child.stdout.on('error', (err) => {
                if (err.code !== 'EPIPE' && err.message !== 'Premature close') {
                    logger.error(`FFmpeg stdout error: ${err.message}`);
                }
            });

            const resource = createAudioResource(child.stdout, {
                inputType: StreamType.Raw,
                inlineVolume: true
            });
            resource.volume.setVolume(this.volume / 100);
            resolve(resource);
        });
    }

    async processQueue() {
        if (this.queueLock || this.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
            return;
        }

        if (this.queue.length === 0 && !this.currentTrack) {
            return;
        }

        this.queueLock = true;

        // Handle repeat logic
        if (this.currentTrack && this.repeatMode === 1) {
            // Repeat song: replay current track
        } else if (this.currentTrack && this.repeatMode === 2) {
            // Repeat queue: push current track to end
            this.queue.push(this.currentTrack);
            // Add to history before moving to next
            if (this.currentTrack) {
                this.history.push(this.currentTrack);
                if (this.history.length > 50) this.history.shift(); // Limit history
            }
            this.currentTrack = this.queue.shift();
        } else {
            // No repeat or just finished a track
            // Add current track to history
            if (this.currentTrack) {
                this.history.push(this.currentTrack);
                if (this.history.length > 50) this.history.shift(); // Limit history
            }
            if (this.queue.length === 0) {
                // Handle autoplay - search for related songs
                if (this.autoplay && this.currentTrack) {
                    try {
                        const searchQuery = `${this.currentTrack.artist || ''} ${this.currentTrack.title || ''} related`.trim();
                        logger.info(`Autoplay: searching for "${searchQuery}"`);
                        const related = await QueryResolver.handleSearch(searchQuery, this.currentTrack.requestedBy);
                        if (related && related.length > 0) {
                            // Add first related track to queue
                            this.queue.push(related[0]);
                            logger.info(`Autoplay: added "${related[0].title}"`);
                        }
                    } catch (e) {
                        logger.error(`Autoplay error: ${e.message}`);
                    }
                }
                
                if (this.queue.length === 0) {
                    this.currentTrack = null;
                    this.queueLock = false;
                    return;
                }
            }
            this.currentTrack = this.queue.shift();
        }

        const track = this.currentTrack;
        if (!track) {
             this.queueLock = false;
             return;
        }

        try {
            // Resolve URL if missing (Lazy Track from Spotify)
            if (!track.url && track.searchQuery) {
                const resolved = await QueryResolver.handleSearch(track.searchQuery, track.requestedBy);
                if (resolved && resolved.length > 0) {
                    track.url = resolved[0].url;
                    track.directUrl = resolved[0].directUrl; // Copy direct URL for fast playback
                    track.directHeaders = resolved[0].directHeaders;
                    track.duration = resolved[0].duration;
                    track.title = track.title || resolved[0].title;
                    track.thumbnail = resolved[0].thumbnail || track.thumbnail;
                    track.artist = track.artist || resolved[0].artist;
                } else {
                    throw new Error('Could not resolve track');
                }
            }

            // Fetch full metadata if needed (for playlist items)
            if (track.needsMetadata && track.url) {
                logger.info(`Fetching metadata for: ${track.url}`);
                const fullInfo = await QueryResolver.getYtDlpInfo(track.url, false);
                if (fullInfo) {
                    track.title = fullInfo.title || fullInfo.fulltitle || track.title;
                    track.duration = fullInfo.duration || track.duration;
                    track.thumbnail = fullInfo.thumbnail || fullInfo.thumbnails?.[0]?.url || track.thumbnail;
                    track.artist = fullInfo.uploader || fullInfo.artist || fullInfo.creator || fullInfo.channel || track.artist;
                    track.needsMetadata = false;
                }
            }

            // Emit playSong event AFTER metadata is resolved
            this.emit('playSong', track);

            // Log track state before creating resource
            logger.info(`Playing track: "${track.title}" | URL: ${track.url} | DirectURL: ${track.directUrl ? 'yes' : 'no'}`);

            // Create resource and play
            const resource = await this.createAudioResource(track.url, track.directUrl, track.directHeaders);
            logger.info(`Audio resource created, playing...`);
            this.audioPlayer.play(resource);
            logger.info(`audioPlayer.play() called, state: ${this.audioPlayer.state.status}`);
            this.playbackStartTime = Date.now(); // Track when playback started
            
            this.queueLock = false;
            
            // Prefetch next track for faster playback
            if (this.queue.length > 0) {
                this.prefetchTrack(this.queue[0]);
            }
        } catch (error) {
            logger.error(`Error playing track ${track.title}: ${error.message}`);
            this.playbackStartTime = null;
            this.queueLock = false;
            this.processQueue();
        }
    }

    // Filter definitions for FFmpeg
    static FILTER_VALUES = {
        'bassboost': 'bass=g=10',
        'nightcore': 'asetrate=48000*1.25,aresample=48000,atempo=1.06',
        'vaporwave': 'asetrate=48000*0.8,aresample=48000,atempo=0.9',
        '8d': 'apulsator=hz=0.08',
        'tremolo': 'tremolo',
        'vibrato': 'vibrato=f=6.5',
        'reverse': 'areverse',
        'treble': 'treble=g=5',
        'normalizer': 'dynaudnorm=f=200',
        'surrounding': 'surround',
        'earrape': 'channelsplit,sidechaingate=level_in=64',
        'karaoke': 'stereotools=mlev=0.03',
        'flanger': 'flanger',
        'gate': 'agate',
        'haas': 'haas',
        'mcompand': 'mcompand',
        'phaser': 'aphaser=in_gain=0.4',
        'pitch_up': 'asetrate=48000*1.15,aresample=48000',
        'pitch_down': 'asetrate=48000*0.85,aresample=48000',
        'slow': 'atempo=0.8',
        'fast': 'atempo=1.25'
    };

    createAudioResource(url, directUrlFromTrack = null, directHeadersFromTrack = null, filters = null) {
        return new Promise((resolve, reject) => {
            // Backwards compatibility: third arg used to be filters
            let activeFilters = filters;
            let directHeaders = directHeadersFromTrack;
            if (Array.isArray(directHeadersFromTrack)) {
                activeFilters = directHeadersFromTrack;
                directHeaders = null;
            }
            
            // Use filters from parameter or from subscription
            activeFilters = activeFilters || this.filters || [];
            
            const hasPrefetchedUrl = url ? this.prefetchedUrls.has(url) : false;
            const hasPrefetchedStream = url ? this.prefetchedStreams.has(url) : false;
            logger.info(`createAudioResource called for URL: ${url}, directUrlFromTrack: ${directUrlFromTrack ? 'yes' : 'no'}, prefetched: ${hasPrefetchedUrl || hasPrefetchedStream ? 'yes' : 'no'}`);
            logger.info(`Active filters (${activeFilters.length}): [${activeFilters.join(', ')}]`);
            
            // Check if we have a direct URL (from search or prefetch)
            const directUrl = directUrlFromTrack || this.prefetchedUrls.get(url);
            const prefetchedHeaders = this.prefetchedHeaders.get(url);
            const resolvedHeaders = directHeaders || prefetchedHeaders;
            const effectiveHeaders = normalizeHeadersForUrl(directUrl, resolvedHeaders);
            
            // Validate direct URL
            // SoundCloud HLS streams with .opus segments don't work with FFmpeg's HLS demuxer
            // (allowed_extensions option is ignored in some FFmpeg builds), so use yt-dlp for those
            const isSoundCloudHls = directUrl && directUrl.includes('sndcdn.com') && directUrl.includes('.opus');

            if (directUrl && (!directUrl.startsWith('http') || directUrl.length < 20)) {
                logger.warn(`Invalid direct URL detected, falling back to yt-dlp: ${directUrl}`);
            } else if (isSoundCloudHls) {
                logger.info(`SoundCloud HLS stream detected, using yt-dlp for compatibility: ${directUrl.substring(0, 80)}...`);
                // Fall through to yt-dlp path below
            } else if (directUrl && !shouldPreferYtdlpStreaming(url)) {
                // Use ffmpeg directly with the direct URL - much faster!
                logger.info(`Using direct URL for faster playback: ${directUrl.substring(0, 100)}...`);
                this.prefetchedUrls.delete(url); // Clean up
                this.prefetchedHeaders.delete(url);

                const startTime = Date.now();

                // Build args - note: spawn passes args directly without shell interpretation
                // so special characters in URL are safe
                const ffmpegArgs = [
                    '-reconnect', '1',
                    '-reconnect_streamed', '1',
                    '-reconnect_delay_max', '5'
                ];

                const headerArgs = buildFfmpegHeaderArgs(effectiveHeaders);
                if (headerArgs.length > 0) {
                    ffmpegArgs.push(...headerArgs);
                }

                ffmpegArgs.push(
                    '-i', directUrl  // URL with & characters is safe in spawn args array
                );
                
                // Add audio filters if any are active
                if (activeFilters.length > 0) {
                    const filterString = activeFilters
                        .map(f => Subscription.FILTER_VALUES[f])
                        .filter(Boolean)
                        .join(',');
                    if (filterString) {
                        ffmpegArgs.push('-af', filterString);
                        logger.info(`Applying filters: ${filterString}`);
                    }
                }
                
                ffmpegArgs.push(
                    '-f', 's16le',
                    '-ar', '48000',
                    '-ac', '2',
                    '-loglevel', 'warning',
                    'pipe:1'
                );
                
                logger.info(`Spawning FFmpeg for direct URL playback`);
                
                const child = spawn(FFMPEG_PATH, ffmpegArgs, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true
                });
                
                child.on('error', (err) => {
                    logger.error(`FFmpeg spawn error: ${err.message}`);
                    reject(err);
                });
                
                // Capture stderr for debugging
                let stderrData = '';
                child.stderr.on('data', (data) => {
                    const msg = data.toString();
                    stderrData += msg;
                    // Only log actual errors, not expected muxer errors from skip/seek
                    const isExpectedError = msg.includes('Error submitting a packet to the muxer') ||
                                           msg.includes('Error muxing a packet') ||
                                           msg.includes('Error writing trailer') ||
                                           msg.includes('Error closing file');
                    if ((msg.includes('error') || msg.includes('Error') || msg.includes('failed')) && !isExpectedError) {
                        logger.warn(`FFmpeg stderr: ${msg.trim()}`);
                    }
                });
                
                child.on('close', (code, signal) => {
                    if (signal) {
                        logger.debug(`FFmpeg killed by signal ${signal}`);
                    } else if (code !== 0 && code !== null) {
                        // Exit code 4294967274 (-22) is expected when stream is interrupted (skip/seek)
                        const isExpectedExit = code === 4294967274 || code === -22 || 
                                              stderrData.includes('Error submitting a packet to the muxer');
                        if (!isExpectedExit) {
                            logger.error(`FFmpeg exited with code ${code}: ${stderrData}`);
                        }
                    } else {
                        logger.debug(`FFmpeg closed normally`);
                    }
                });
                
                child.stdout.once('data', () => {
                    logger.info(`FFmpeg first data after ${Date.now() - startTime}ms`);
                });
                
                // Handle stdout errors (broken pipe when skipping)
                child.stdout.on('error', (err) => {
                    // EPIPE and 'Premature close' are expected when skipping/seeking
                    if (err.code !== 'EPIPE' && err.message !== 'Premature close') {
                        logger.error(`FFmpeg stdout error: ${err.message}`);
                    }
                });
                
                const resource = createAudioResource(child.stdout, { 
                    inputType: StreamType.Raw,
                    inlineVolume: true 
                });
                resource.volume.setVolume(this.volume / 100);
                resolve(resource);
                return;
            } else if (directUrl) {
                logger.info('Skipping direct URL playback; using yt-dlp streaming (cookies or config present).');
            }
            
            // Fallback: use yt-dlp to stream (slower but works)
            const startTime = Date.now();
            let prefetched = this._takePrefetchedStream(url);
            let sourceStream;
            let errorOutput = '';

            if (prefetched) {
                sourceStream = prefetched.stream;
                const ageMs = Date.now() - prefetched.startedAt;
                logger.info(`Using prefetched yt-dlp stream (age ${ageMs}ms)`);
            } else {
                logger.info(`No direct URL, using yt-dlp streaming (slower)`);
                const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';
                const args = buildYtdlpStreamArgs(url);
                const ytdlp = spawn(ytdlpPath, args);

                sourceStream = ytdlp.stdout;
                
                ytdlp.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });
                
                ytdlp.on('error', (err) => {
                    reject(err);
                });

                // Handle process exit for errors
                ytdlp.on('close', (code) => {
                    if (code !== 0 && code !== null) {
                        logger.error(`yt-dlp exited with code ${code}: ${errorOutput}`);
                        // Detect auth failures (403 Forbidden) - only track for YouTube
                        const isYouTube = /youtube\.com|youtu\.be/i.test(url);
                        if (isYouTube && (errorOutput.includes('403') || errorOutput.includes('Forbidden') ||
                            errorOutput.includes('Sign in to confirm') || errorOutput.includes('Please sign in'))) {
                            recordYtAuthFailure();
                        }
                    }
                });
            }
            
            // If we have filters, pipe through FFmpeg
            if (activeFilters.length > 0) {
                const filterString = activeFilters
                    .map(f => Subscription.FILTER_VALUES[f])
                    .filter(Boolean)
                    .join(',');
                
                const ffmpegArgs = [
                    '-i', 'pipe:0',
                    '-af', filterString,
                    '-f', 's16le',
                    '-ar', '48000',
                    '-ac', '2',
                    '-loglevel', 'error',
                    'pipe:1'
                ];
                
                const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs);
                sourceStream.pipe(ffmpeg.stdin);
                
                ffmpeg.stdout.once('data', () => {
                    const label = prefetched ? 'prefetched yt-dlp+FFmpeg' : 'yt-dlp+FFmpeg';
                    logger.info(`${label} first data after ${Date.now() - startTime}ms (with filters)`);
                    // Reset auth failures on successful stream
                    if (ytAuthFailureCount > 0) resetYtAuthFailures();
                });
                
                const resource = createAudioResource(ffmpeg.stdout, { 
                    inputType: StreamType.Raw,
                    inlineVolume: true 
                });
                resource.volume.setVolume(this.volume / 100);
                resolve(resource);
            } else {
                sourceStream.once('data', () => {
                    const label = prefetched ? 'prefetched yt-dlp' : 'yt-dlp';
                    logger.info(`${label} first data after ${Date.now() - startTime}ms`);
                    // Reset auth failures on successful stream
                    if (ytAuthFailureCount > 0) resetYtAuthFailures();
                });

                // Create resource from stdout stream immediately - don't wait for data
                const resource = createAudioResource(sourceStream, { inlineVolume: true });
                resource.volume.setVolume(this.volume / 100);
                resolve(resource);
            }
        });
    }

    setVolume(volume) {
        if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
            const resource = this.audioPlayer.state.resource;
            if (resource && resource.volume) {
                resource.volume.setVolume(volume / 100);
            }
        }
        this.volume = volume;
    }
    
    /**
     * Enable voice commands for this subscription
     * @param {TextChannel} textChannel - Channel to send feedback messages
     * @param {Client} client - Discord client for user lookups
     * @returns {Promise<boolean>} - Whether voice commands were enabled successfully
     */
    async enableVoiceCommands(textChannel, client) {
        if (this.voiceCommandListener) {
            logger.info('Voice commands already enabled');
            return true;
        }
        
        try {
            const VoiceCommandListener = require('./VoiceCommandListener');
            this.voiceCommandListener = new VoiceCommandListener(this, textChannel, client);
            const success = await this.voiceCommandListener.start();
            
            if (!success) {
                this.voiceCommandListener = null;
                return false;
            }
            
            logger.info('Voice commands enabled for subscription');
            
            // Undeafen so the bot can hear voice commands
            try {
                const { getVoiceConnection } = require('@discordjs/voice');
                const connection = this.voiceConnection;
                if (connection && connection.joinConfig) {
                    connection.rejoin({
                        ...connection.joinConfig,
                        selfDeaf: false
                    });
                }
            } catch (e) {
                logger.debug(`Could not update deaf state: ${e.message}`);
            }
            
            return true;
        } catch (e) {
            logger.error(`Failed to enable voice commands: ${e.message}`);
            this.voiceCommandListener = null;
            return false;
        }
    }
    
    /**
     * Disable voice commands for this subscription
     */
    disableVoiceCommands() {
        if (this.voiceCommandListener) {
            this.voiceCommandListener.stop();
            this.voiceCommandListener = null;
            logger.info('Voice commands disabled for subscription');
            
            // Deafen the bot since it no longer needs to listen
            try {
                const connection = this.voiceConnection;
                if (connection && connection.joinConfig) {
                    connection.rejoin({
                        ...connection.joinConfig,
                        selfDeaf: true
                    });
                }
            } catch (e) {
                logger.debug(`Could not update deaf state: ${e.message}`);
            }
        }
    }
    
    /**
     * Check if voice commands are enabled
     */
    get voiceCommandsEnabled() {
        return this.voiceCommandListener?.enabled ?? false;
    }
}

module.exports = Subscription;
