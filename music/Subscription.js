const { AudioPlayerStatus, createAudioPlayer, createAudioResource, entersState, VoiceConnectionStatus, StreamType, NoSubscriberBehavior } = require('@discordjs/voice');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const logger = require('../logger').child('music');
const fs = require('fs');
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

class Subscription extends EventEmitter {
    constructor(voiceConnection) {
        super();
        this.voiceConnection = voiceConnection;
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
        this._prefetching = new Set(); // Track URLs/queries currently being prefetched
        this._destroying = false; // Flag to prevent events during cleanup

        this.voiceConnection.on('stateChange', async (_, newState) => {
            if (newState.status === VoiceConnectionStatus.Disconnected) {
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
        if (shouldEmitAddSong) {
            this.emit('addSong', track);
        }
        
        // Prefetch the next track's stream URL for faster playback
        if (this.currentTrack && this.queue.length === 1) {
            this.prefetchTrack(track);
        }
        
        this.processQueue();
    }
    
    // Pre-fetch the direct stream URL to reduce delay when playing
    async prefetchTrack(track) {
        // Create a unique key for this track
        const prefetchKey = track.url || track.searchQuery;
        if (!prefetchKey) return;
        
        // Skip if already prefetching or prefetched
        if (this._prefetching.has(prefetchKey)) return;
        if (track.directUrl) return;
        if (track.url && this.prefetchedUrls.has(track.url)) return;
        
        this._prefetching.add(prefetchKey);
        
        try {
            // For Spotify tracks without URL, resolve via search first
            if (!track.url && track.searchQuery) {
                const resolved = await QueryResolver.handleSearch(track.searchQuery, track.requestedBy);
                if (resolved && resolved.length > 0) {
                    track.url = resolved[0].url;
                    track.directUrl = resolved[0].directUrl;
                    track.duration = resolved[0].duration;
                    track.title = track.title || resolved[0].title;
                    track.thumbnail = resolved[0].thumbnail || track.thumbnail;
                    track.artist = track.artist || resolved[0].artist;
                    logger.info(`Pre-resolved Spotify track: ${track.title}`);
                }
                this._prefetching.delete(prefetchKey);
                return;
            }
            
            // Skip if no URL or already has directUrl
            if (!track.url || track.directUrl) {
                this._prefetching.delete(prefetchKey);
                return;
            }
            
            const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';
            const directUrl = await new Promise((resolve, reject) => {
                execFile(ytdlpPath, [
                    '-g',  // Get URL only
                    '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
                    '--no-warnings',
                    '--no-playlist',
                    track.url
                ], { timeout: 30000 }, (error, stdout, stderr) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(stdout.trim().split('\n')[0]); // First URL
                    }
                });
            });
            
            if (directUrl) {
                this.prefetchedUrls.set(track.url, directUrl);
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
        const resource = await this.createAudioResource(previousTrack.url, previousTrack.directUrl);
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
                targetTrack.duration = resolved[0].duration;
                targetTrack.title = targetTrack.title || resolved[0].title;
                targetTrack.thumbnail = resolved[0].thumbnail || targetTrack.thumbnail;
                targetTrack.artist = targetTrack.artist || resolved[0].artist;
            }
        }
        
        // Play the target track
        const resource = await this.createAudioResource(targetTrack.url, targetTrack.directUrl);
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
        const directUrl = track.directUrl || this.prefetchedUrls.get(track.url);
        
        // Get direct URL if we don't have one
        let streamUrl = directUrl;
        if (!streamUrl) {
            streamUrl = await QueryResolver.getDirectStreamUrl(track.url);
        }
        
        if (!streamUrl) {
            throw new Error('Could not get stream URL for seek');
        }
        
        // Create new resource with seek position
        const resource = await this.createAudioResourceWithSeek(streamUrl, timeSeconds);
        this.audioPlayer.play(resource);
        
        logger.info(`Seeked to ${timeSeconds}s in ${track.title}`);
    }
    
    // Create audio resource with a seek offset
    createAudioResourceWithSeek(directUrl, seekSeconds) {
        return new Promise((resolve, reject) => {
            const child = spawn(FFMPEG_PATH, [
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',
                '-ss', seekSeconds.toString(), // Seek to position
                '-i', directUrl,
                '-f', 's16le',
                '-ar', '48000',
                '-ac', '2',
                '-loglevel', 'error',
                'pipe:1'
            ]);
            
            child.on('error', reject);
            
            const resource = createAudioResource(child.stdout, {
                inputType: StreamType.Raw,
                inlineVolume: true
            });
            resource.volume.setVolume(this.volume / 100);
            resolve(resource);
        });
    }
    
    // Create audio resource with filters and optional seek
    createAudioResourceWithFilters(directUrl, seekSeconds = 0, filters = []) {
        return new Promise((resolve, reject) => {
            const ffmpegArgs = [
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5'
            ];
            
            // Add seek if needed
            if (seekSeconds > 0) {
                ffmpegArgs.push('-ss', seekSeconds.toString());
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
                '-loglevel', 'error',
                'pipe:1'
            );
            
            const child = spawn(FFMPEG_PATH, ffmpegArgs);
            
            child.on('error', reject);
            
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
            const resource = await this.createAudioResource(track.url, track.directUrl);
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

    createAudioResource(url, directUrlFromTrack = null, filters = null) {
        return new Promise((resolve, reject) => {
            // Use filters from parameter or from subscription
            const activeFilters = filters || this.filters || [];
            
            logger.info(`createAudioResource called for URL: ${url}, directUrlFromTrack: ${directUrlFromTrack ? 'yes' : 'no'}, prefetched: ${this.prefetchedUrls.has(url) ? 'yes' : 'no'}`);
            logger.info(`Active filters (${activeFilters.length}): [${activeFilters.join(', ')}]`);
            
            // Check if we have a direct URL (from search or prefetch)
            const directUrl = directUrlFromTrack || this.prefetchedUrls.get(url);
            
            // Validate direct URL
            if (directUrl && (!directUrl.startsWith('http') || directUrl.length < 20)) {
                logger.warn(`Invalid direct URL detected, falling back to yt-dlp: ${directUrl}`);
            } else if (directUrl) {
                // Use ffmpeg directly with the direct URL - much faster!
                logger.info(`Using direct URL for faster playback: ${directUrl.substring(0, 100)}...`);
                this.prefetchedUrls.delete(url); // Clean up
                
                const startTime = Date.now();
                
                // Build args - note: spawn passes args directly without shell interpretation
                // so special characters in URL are safe
                const ffmpegArgs = [
                    '-reconnect', '1',
                    '-reconnect_streamed', '1', 
                    '-reconnect_delay_max', '5',
                    '-i', directUrl  // URL with & characters is safe in spawn args array
                ];
                
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
            }
            
            // Fallback: use yt-dlp to stream (slower but works)
            logger.info(`No direct URL, using yt-dlp streaming (slower)`);
            const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';
            const startTime = Date.now();
            const args = [
                '-o', '-',
                '-q',
                '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
                '--no-warnings',
                '--no-playlist',
                '--no-part',           // Don't create .part files
                '--no-mtime',          // Don't set file modification time
                '--buffer-size', '16K',
                url
            ];

            const ytdlp = spawn(ytdlpPath, args);
            
            let errorOutput = '';
            ytdlp.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });
            
            ytdlp.on('error', (err) => {
                reject(err);
            });
            
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
                ytdlp.stdout.pipe(ffmpeg.stdin);
                
                ffmpeg.stdout.once('data', () => {
                    logger.info(`yt-dlp+FFmpeg first data after ${Date.now() - startTime}ms (with filters)`);
                });
                
                const resource = createAudioResource(ffmpeg.stdout, { 
                    inputType: StreamType.Raw,
                    inlineVolume: true 
                });
                resource.volume.setVolume(this.volume / 100);
                resolve(resource);
            } else {
                ytdlp.stdout.once('data', () => {
                    logger.info(`yt-dlp first data after ${Date.now() - startTime}ms`);
                });

                // Create resource from stdout stream immediately - don't wait for data
                const resource = createAudioResource(ytdlp.stdout, { inlineVolume: true });
                resource.volume.setVolume(this.volume / 100);
                resolve(resource);
            }
            
            // Handle process exit for errors
            ytdlp.on('close', (code) => {
                if (code !== 0 && code !== null) {
                    logger.error(`yt-dlp exited with code ${code}: ${errorOutput}`);
                }
            });
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
