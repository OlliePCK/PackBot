/**
 * VoiceCommandListener - Voice control for PackBot music
 * Uses Deepgram for real-time, accurate speech-to-text with "pack bot" wake phrase
 * 
 * Privacy: Deepgram is SOC 2 Type II compliant and does not train on customer data.
 * https://deepgram.com/privacy
 * 
 * Supported commands after wake phrase:
 * - "play [song name]" - Queue a song
 * - "skip" - Skip current track  
 * - "stop" - Stop playback and clear queue
 * - "pause" - Pause playback
 * - "resume" / "unpause" - Resume playback
 * - "volume [number]" - Set volume (0-200)
 * - "next" - Same as skip
 * - "previous" / "back" - Play previous track
 * - "shuffle" - Shuffle the queue
 */

const { EndBehaviorType } = require('@discordjs/voice');
const { Transform } = require('stream');
const { EventEmitter } = require('events');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const logger = require('../logger').child('voice-control');

// Wake phrase variations (all lowercase) - expanded for better recognition
const WAKE_PHRASES = [
    // Standard variations
    'pack bot', 'packbot', 'pack bought', 'pack but', 'packed bot', 'pack pod', 
    'pakbot', 'pak bot', 'back bot', 'hack bot', 'hackbot', 'pat bot', 'packed butt',
    'pack bud', 'pack about', 'pact bot', 'pack body', 'packbox', 'pack box',
    'pack bob', 'pac bot', 'pacbot', 'packed bots', 'pack bots', 'hackbox', 'hack box',
    'back box', 'backbot', 'black bot', 'black box', 'pack butt', 'packbutt', 'pack but',
    // Additional mishearings from logs
    'packball', 'pack ball', 'pack pot', 'packpot', 'pack put', 'pick put', 
    'pac pot', 'pacpot', 'pax bot', 'paxbot',
    'pack buck', 'packbuck', 'parrot bot', 'parrotbot', 'pack part', 'packpart',
    'passport', 'pack spot', 'pact pot', 'fact bot', 'factbot', 'pack putt',
    'pick bot', 'pickbot', 'pic bot', 'picbot'
    // Note: "pack button" removed - it cuts "volume" commands incorrectly
];

// Regex pattern for fuzzy wake phrase matching (handles variations better)
// Note: Removed "button" ending as it interferes with "volume" commands
const WAKE_PHRASE_REGEX = /\b(?:p[aeiou]c?k?|b[aeiou]ck|h[aeiou]ck|bl[aeiou]ck|f[aeiou]ct|p[aeiou]x|p[aeiou]rr?ot|p[aeiou]ss?p?ort?)\s*(?:b[oua]t{1,2}|p[oua]t{1,2}|b[oua][xdlk]|b[oua]ck|b[oua]ll|b[oua]b|butt)\b/gi;

// Known command words - used to find commands even when wake phrase cuts into them
const COMMAND_KEYWORDS = ['play', 'skip', 'stop', 'pause', 'resume', 'unpause', 'volume', 'next', 'previous', 'back', 'shuffle', 'queue'];

// False positive phrases that sound like wake phrase but aren't
const FALSE_POSITIVES = [
    'i bought', 'i brought', 'i bot', 'i thought'
];

// Common speech-to-text corrections for artist/song names
const QUERY_CORRECTIONS = {
    'yeet': 'yeat',
    'yeats': 'yeat',
    'yet': 'yeat',
    'lynard skinner': 'lynyrd skynyrd',
    'leonard skinner': 'lynyrd skynyrd',
    'lynerd skynerd': 'lynyrd skynyrd',
    'acdc': 'ac/dc',
    'ac dc': 'ac/dc',
    'guns and roses': 'guns n roses',
    'red hot chilly peppers': 'red hot chili peppers',
    'led zeppelin': 'led zeppelin',
    'led zepplin': 'led zeppelin',
    'metalica': 'metallica',
    'metalika': 'metallica',
    'nirvanna': 'nirvana',
    'pink floid': 'pink floyd',
    'ariana grande': 'ariana grande',
    'arianna grande': 'ariana grande',
    'billie eyelash': 'billie eilish',
    'billy eilish': 'billie eilish',
    'post malone': 'post malone',
    'post maloan': 'post malone',
};

// Apply corrections to a query
function correctQuery(query) {
    let corrected = query.toLowerCase();
    for (const [wrong, right] of Object.entries(QUERY_CORRECTIONS)) {
        // Use word boundaries to avoid partial matches
        const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
        corrected = corrected.replace(regex, right);
    }
    return corrected;
}

// Convert word numbers to digits (for volume commands)
const WORD_NUMBERS = {
    'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
    'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'twenty': 20,
    'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70,
    'eighty': 80, 'ninety': 90, 'hundred': 100, 'one hundred': 100, 'two hundred': 200
};

// Parse volume from text (handles "50", "fifty", "one fifty", "one hundred fifty")
function parseVolumeFromText(text) {
    // First try direct number
    const directNum = parseInt(text, 10);
    if (!isNaN(directNum)) return directNum;
    
    // Try word-to-number conversion
    const lower = text.toLowerCase().trim();
    
    // Handle compound numbers like "one fifty" = 150, "one hundred" = 100
    const words = lower.split(/\s+/);
    let total = 0;
    
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const num = WORD_NUMBERS[word];
        
        if (num !== undefined) {
            // If it's "hundred", multiply previous number or use 100
            if (word === 'hundred') {
                if (total > 0) {
                    total *= 100;
                } else {
                    total = 100;
                }
            } else if (num >= 100) {
                total += num;
            } else if (total > 0 && total < 10 && num < 100) {
                // Handle "one fifty" = 150 (1 * 100 + 50)
                total = total * 100 + num;
            } else {
                total += num;
            }
        }
    }
    
    return total > 0 ? total : null;
}

// Command patterns (regex) - made flexible for speech recognition variations
// Note: Patterns should not require $ at end since punctuation may be present
const COMMAND_PATTERNS = {
    play: /^(?:play|played|playing|plate)\s+(.+?)(?:\.|$)/i,
    skip: /^(?:skip|skipped|next|necks?|escape)\s*$/i,
    stop: /^(?:stop|stopped)\s*$/i,
    pause: /^(?:pause|paused|paws)\s*$/i,
    resume: /^(?:resume|resumed|unpause|unpaused)\s*$/i,
    volume: /^(?:on\s+)?(?:volume|volumes?)\s+(.+?)\s*$/i,  // "on volume X" or "volume X" - handles "pack button volume" -> "on volume"
    previous: /^(?:previous|back|go back)\s*$/i,
    shuffle: /^(?:shuffle|shuffled)\s*$/i,
    queue: /^(?:queue|que|cue)\s*$/i,
};

/**
 * Converts Opus packets from Discord to PCM for Deepgram
 * Outputs 16-bit PCM at 16kHz mono (Deepgram preferred format)
 */
class OpusToPCM extends Transform {
    constructor(options = {}) {
        super(options);
        this.decoder = null;
        
        try {
            const prism = require('prism-media');
            this.decoder = new prism.opus.Decoder({
                rate: 16000,
                channels: 1,
                frameSize: 960
            });
            
            this.decoder.on('data', (chunk) => {
                this.push(chunk);
            });
            
            this.decoder.on('error', (err) => {
                logger.debug(`Opus decoder error: ${err.message}`);
            });
        } catch (e) {
            logger.error(`Failed to create Opus decoder: ${e.message}`);
        }
    }
    
    _transform(chunk, encoding, callback) {
        if (this.decoder) {
            try {
                this.decoder.write(chunk);
            } catch (e) {
                // Ignore decode errors
            }
        }
        callback();
    }
    
    _flush(callback) {
        if (this.decoder) {
            this.decoder.end();
        }
        callback();
    }
}

class VoiceCommandListener extends EventEmitter {
    constructor(subscription, textChannel, client) {
        super();
        this.subscription = subscription;
        this.textChannel = textChannel;
        this.client = client;
        this.deepgram = null;
        this.liveConnection = null;
        this.audioStreams = new Map(); // userId -> stream
        this.pcmConverters = new Map(); // userId -> OpusToPCM
        this.enabled = false;
        this.lastCommandTime = new Map(); // userId -> timestamp (cooldown)
        this.commandCooldown = 2000; // 2 second cooldown
        
        // Pending wake phrase tracking - handles split transcripts
        this.pendingWakePhrase = null; // { userId, timestamp }
        this.pendingWakeTimeout = null;
        this.wakePhraseTTL = 4000; // 4 seconds to complete command after wake phrase
        this.currentSpeakingUser = null;
        this.lastSpeakingUser = null; // Backup in case currentSpeakingUser is null
        this.lastSpeakingTime = 0;
        this.keepAliveInterval = null;
        this.receiver = null;
        this._onSpeakingStart = null;
        this._onSpeakingEnd = null;
    }
    
    /**
     * Check if Deepgram API key is configured
     */
    checkDeepgramAvailable() {
        const apiKey = process.env.DEEPGRAM_API_KEY;
        if (!apiKey) {
            logger.error('DEEPGRAM_API_KEY not set in environment variables');
            return false;
        }
        
        this.deepgram = createClient(apiKey);
        logger.info('Deepgram API configured');
        return true;
    }
    
    /**
     * Start the Deepgram live connection
     */
    async startDeepgramConnection() {
        if (this.liveConnection) {
            return true;
        }
        
        try {
            this.liveConnection = this.deepgram.listen.live({
                model: 'nova-2',
                language: 'en-US',
                smart_format: true,
                punctuate: true,
                interim_results: true,
                utterance_end_ms: 1000,
                vad_events: true,
                encoding: 'linear16',
                sample_rate: 16000,
                channels: 1,
            });
            
            this.liveConnection.on(LiveTranscriptionEvents.Open, () => {
                logger.info('Deepgram connection opened');
                
                // Keep alive every 10 seconds
                this.keepAliveInterval = setInterval(() => {
                    if (this.liveConnection) {
                        this.liveConnection.keepAlive();
                    }
                }, 10000);
            });
            
            this.liveConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
                const transcript = data.channel?.alternatives?.[0]?.transcript;
                if (transcript && transcript.trim()) {
                    const isFinal = data.is_final;
                    // Use currentSpeakingUser, or fall back to lastSpeakingUser if recent (within 3s)
                    let userId = this.currentSpeakingUser;
                    if (!userId && this.lastSpeakingUser && (Date.now() - this.lastSpeakingTime) < 3000) {
                        userId = this.lastSpeakingUser;
                    }
                    
                    if (isFinal) {
                        logger.info(`[${userId || 'unknown'}] Transcript: "${transcript}"`);
                        this.processTranscription(userId, transcript);
                    } else {
                        logger.debug(`[${userId || 'unknown'}] Interim: "${transcript}"`);
                    }
                }
            });
            
            this.liveConnection.on(LiveTranscriptionEvents.Error, (err) => {
                logger.error(`Deepgram error: ${err.message}`);
            });
            
            this.liveConnection.on(LiveTranscriptionEvents.Close, () => {
                logger.info('Deepgram connection closed');
                this.liveConnection = null;
                if (this.keepAliveInterval) {
                    clearInterval(this.keepAliveInterval);
                    this.keepAliveInterval = null;
                }
            });
            
            // Wait for connection to open
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
                this.liveConnection.on(LiveTranscriptionEvents.Open, () => {
                    clearTimeout(timeout);
                    resolve();
                });
                this.liveConnection.on(LiveTranscriptionEvents.Error, (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
            });
            
            return true;
        } catch (e) {
            logger.error(`Failed to start Deepgram connection: ${e.message}`);
            this.liveConnection = null;
            return false;
        }
    }
    
    /**
     * Start listening for voice commands
     */
    async start() {
        if (!this.checkDeepgramAvailable()) {
            return false;
        }
        
        const connected = await this.startDeepgramConnection();
        if (!connected) {
            return false;
        }
        
        this.enabled = true;
        
        const receiver = this.subscription.voiceConnection.receiver;
        this.receiver = receiver;
        
        // Listen for users speaking
        this._onSpeakingStart = (userId) => {
            if (!this.enabled) return;
            this.startListening(userId);
        };
        
        this._onSpeakingEnd = (userId) => {
            // User stopped speaking - remember them as last speaker
            if (this.currentSpeakingUser === userId) {
                this.lastSpeakingUser = userId;
                this.lastSpeakingTime = Date.now();
                this.currentSpeakingUser = null;
            }
        };

        receiver.speaking.on('start', this._onSpeakingStart);
        receiver.speaking.on('end', this._onSpeakingEnd);
        
        logger.info('Voice command listener started with Deepgram');
        
        // Note: The calling command (join/play/voice enable) shows the voice enabled message
        // No need for duplicate message here
        
        return true;
    }
    
    /**
     * Start listening to a specific user
     */
    startListening(userId) {
        if (this.audioStreams.has(userId)) return;
        if (!this.liveConnection) return;
        
        const receiver = this.subscription.voiceConnection.receiver;
        
        try {
            const audioStream = receiver.subscribe(userId, {
                end: {
                    behavior: EndBehaviorType.AfterSilence,
                    duration: 1000,
                }
            });
            
            const pcmStream = new OpusToPCM();
            
            this.currentSpeakingUser = userId;
            this.audioStreams.set(userId, audioStream);
            this.pcmConverters.set(userId, pcmStream);
            
            audioStream.pipe(pcmStream);
            
            // Send PCM data to Deepgram
            pcmStream.on('data', (chunk) => {
                if (this.liveConnection) {
                    try {
                        this.liveConnection.send(chunk);
                    } catch (e) {
                        logger.debug(`Failed to send audio to Deepgram: ${e.message}`);
                    }
                }
            });
            
            audioStream.on('end', () => {
                this.cleanupUser(userId);
            });
            
            audioStream.on('error', (err) => {
                logger.debug(`Audio stream error for ${userId}: ${err.message}`);
                this.cleanupUser(userId);
            });
            
        } catch (e) {
            logger.debug(`Failed to subscribe to user ${userId}: ${e.message}`);
        }
    }
    
    /**
     * Process transcribed text for commands
     */
    processTranscription(userId, text) {
        const lowerText = text.toLowerCase().trim();
        
        if (lowerText.length < 3) return;
        
        // Check for false positives first
        for (const fp of FALSE_POSITIVES) {
            if (lowerText.includes(fp)) {
                logger.debug(`Ignoring false positive: "${fp}" in "${lowerText}"`);
                return;
            }
        }
        
        // Check for wake phrase using both exact match list AND fuzzy regex
        let commandText = null;
        let bestWakeIndex = -1;
        let bestWakeLength = 0;
        
        // First try exact matches from the list
        for (const wake of WAKE_PHRASES) {
            const wakeIndex = lowerText.lastIndexOf(wake);
            // Prefer longer wake phrase matches at same position, or later matches
            if (wakeIndex >= 0 && (wakeIndex > bestWakeIndex || (wakeIndex === bestWakeIndex && wake.length > bestWakeLength))) {
                bestWakeIndex = wakeIndex;
                bestWakeLength = wake.length;
                commandText = lowerText.substring(wakeIndex + wake.length).trim();
            }
        }
        
        // Also try fuzzy regex matching for variations not in the list
        if (bestWakeIndex < 0) {
            WAKE_PHRASE_REGEX.lastIndex = 0; // Reset regex state
            let match;
            while ((match = WAKE_PHRASE_REGEX.exec(lowerText)) !== null) {
                if (match.index > bestWakeIndex) {
                    bestWakeIndex = match.index;
                    bestWakeLength = match[0].length;
                    commandText = lowerText.substring(match.index + match[0].length).trim();
                    logger.debug(`Fuzzy wake phrase match: "${match[0]}"`);
                }
            }
        }
        
        // If no wake phrase found, check if there's a pending wake phrase from previous transcript
        if (commandText === null) {
            if (this.pendingWakePhrase && (Date.now() - this.pendingWakePhrase.timestamp) < this.wakePhraseTTL) {
                // Previous transcript had wake phrase, treat this as the command
                commandText = lowerText.replace(/^[,.\s:]+/, '').trim();
                userId = this.pendingWakePhrase.userId || userId;
                logger.info(`Using pending wake phrase, command: "${commandText}"`);
                this.clearPendingWake();
            } else {
                return;
            }
        }
        
        // Remove leading punctuation and clean up
        commandText = commandText.replace(/^[,.\s:]+/, '').trim();
        
        // Check if the command starts with a partial word that should be a command keyword
        // e.g., "pack button volume" -> "on volume" should become "volume"
        // Look for command keywords in the extracted text
        if (commandText && !COMMAND_KEYWORDS.some(kw => commandText.toLowerCase().startsWith(kw))) {
            // Command doesn't start with a known keyword - check if there's one nearby
            for (const keyword of COMMAND_KEYWORDS) {
                const kwIndex = commandText.toLowerCase().indexOf(keyword);
                if (kwIndex > 0 && kwIndex <= 4) {
                    // Found keyword within first few characters - likely partial word before it
                    const corrected = commandText.substring(kwIndex);
                    logger.debug(`Command corrected: "${commandText}" -> "${corrected}"`);
                    commandText = corrected;
                    break;
                }
            }
        }
        
        // Remove trailing punctuation for simple commands
        commandText = commandText.replace(/[.,!?]+$/, '').trim();
        
        if (!commandText) {
            // Wake phrase at end - save it for next transcript
            logger.info('Wake phrase detected, waiting for command...');
            this.pendingWakePhrase = { userId, timestamp: Date.now() };
            
            // Clear pending after TTL
            if (this.pendingWakeTimeout) clearTimeout(this.pendingWakeTimeout);
            this.pendingWakeTimeout = setTimeout(() => {
                this.clearPendingWake();
            }, this.wakePhraseTTL);
            return;
        }
        
        // Clear any pending wake phrase since we're executing now
        this.clearPendingWake();
        
        // Check cooldown (use 'unknown' key if userId is null)
        const cooldownKey = userId || 'unknown';
        const lastCommand = this.lastCommandTime.get(cooldownKey) || 0;
        if (Date.now() - lastCommand < this.commandCooldown) {
            logger.debug(`Command from ${cooldownKey} ignored (cooldown)`);
            return;
        }
        
        this.lastCommandTime.set(cooldownKey, Date.now());
        this.executeCommand(userId, commandText);
    }
    
    /**
     * Clear pending wake phrase state
     */
    clearPendingWake() {
        this.pendingWakePhrase = null;
        if (this.pendingWakeTimeout) {
            clearTimeout(this.pendingWakeTimeout);
            this.pendingWakeTimeout = null;
        }
    }
    
    /**
     * Execute a voice command
     */
    async executeCommand(userId, commandText) {
        logger.info(`Executing voice command from ${userId || 'unknown'}: "${commandText}"`);
        const timingStart = Date.now();
        const logTimings = process.env.LOG_MUSIC_TIMINGS === '1' || process.env.LOG_MUSIC_TIMINGS === 'true';
        
        let user = null;
        if (userId) {
            user = this.client.users.cache.get(userId);
            if (!user) {
                try {
                    user = await this.client.users.fetch(userId);
                } catch (e) {
                    // ignore fetch error
                }
            }
        }
        
        // Fallback: If we still don't have a user and only one person is in the voice channel (besides the bot)
        if (!user) {
            try {
                const voiceChannel = this.subscription.voiceConnection?.joinConfig?.channelId;
                if (voiceChannel) {
                    const channel = this.client.channels.cache.get(voiceChannel);
                    if (channel && channel.members) {
                        // Filter out the bot
                        const humanMembers = channel.members.filter(m => !m.user.bot);
                        if (humanMembers.size === 1) {
                            user = humanMembers.first().user;
                            logger.debug(`Voice command attributed to only user in channel: ${user.tag}`);
                        }
                    }
                }
            } catch (e) {
                // ignore
            }
        }
        
        if (!user) {
            // Create a more descriptive fallback
            user = { 
                toString: () => '🎤 Voice User', 
                id: userId || 'unknown',
                username: 'Voice User',
                tag: 'Voice User'
            };
        }
        
        // Match against command patterns
        for (const [cmd, pattern] of Object.entries(COMMAND_PATTERNS)) {
            const match = commandText.match(pattern);
            if (match) {
                try {
                    await this.runCommand(cmd, match, user);
                } catch (e) {
                    logger.error(`Voice command error: ${e.message}`);
                    this.sendFeedback(`❌ Error: ${e.message}`);
                }
                return;
            }
        }
        
        // No pattern matched - treat as play command
        if (commandText.length > 2) {
            try {
                await this.runCommand('play', [commandText, commandText], user);
            } catch (e) {
                logger.error(`Voice command error: ${e.message}`);
                this.sendFeedback(`❌ Error: ${e.message}`);
            }
        }
    }
    
    /**
     * Run a specific command
     */
    async runCommand(cmd, match, user) {
        const sub = this.subscription;
        const emotes = this.client.emotes || {};
        
        switch (cmd) {
            case 'play': {
                const rawQuery = match[1];
                const query = correctQuery(rawQuery);
                
                if (query !== rawQuery.toLowerCase()) {
                    logger.info(`Voice query corrected: "${rawQuery}" -> "${query}"`);
                }
                
                this.sendFeedback({
                    title: `${emotes.search || '🔍'} | Searching...`,
                    description: `"${query}"`,
                    user: user,
                    color: '#ff006a'
                });
                
                const QueryResolver = require('./QueryResolver');
                const resolveStart = Date.now();
                const tracks = await QueryResolver.resolve(query, user);
                const resolveMs = Date.now() - resolveStart;
                if (logTimings) {
                    logger.info(`Timing: QueryResolver.resolve() took ${resolveMs}ms (voice:play)`);
                }
                
                if (!tracks || tracks.length === 0) {
                    this.sendFeedback({
                        title: `${emotes.error || '❌'} | No Results`,
                        description: `No results found for "${query}"`,
                        color: '#ff0000'
                    });
                    return;
                }
                
                // Suppress addSong events for voice commands (we show our own feedback)
                sub._suppressAddSong = true;
                for (const track of tracks) {
                    track._timing = track._timing || {};
                    track._timing.requestStart = timingStart;
                    track._timing.requestSource = 'voice:play';
                    track._timing.resolveMs = resolveMs;
                    sub.enqueue(track);
                }
                sub._suppressAddSong = false;
                
                if (tracks.length === 1) {
                    this.sendFeedback({
                        title: `${emotes.success || '✅'} | Song added: ${tracks[0].title}`,
                        url: tracks[0].url || '',
                        thumbnail: tracks[0].thumbnail,
                        fields: [
                            { name: 'Duration', value: `\`${tracks[0].formattedDuration}\``, inline: true },
                            { name: 'Requested by', value: `${user}`, inline: true },
                            { name: 'Position in queue', value: `${sub.queue.length}`, inline: true },
                        ],
                        color: '#ff006a'
                    });
                } else {
                    this.sendFeedback({
                        title: `${emotes.success || '✅'} | Playlist added`,
                        description: `Queued **${tracks.length}** tracks`,
                        fields: [
                            { name: 'Requested by', value: `${user}`, inline: true },
                        ],
                        color: '#ff006a'
                    });
                }
                break;
            }
            
            case 'skip':
                // Event handler in play.js will send the feedback embed
                sub.skip(user);
                break;
            
            case 'stop':
                // Event handler in play.js will send the feedback embed
                sub.stop(user);
                break;
            
            case 'pause':
                if (sub.audioPlayer.pause()) {
                    this.sendFeedback({
                        title: `${emotes.pause || '⏸️'} | Paused`,
                        description: sub.currentTrack ? `Paused: **${sub.currentTrack.title}**` : 'Playback paused',
                        user: user,
                        color: '#ff006a'
                    });
                } else {
                    this.sendFeedback({
                        title: `${emotes.error || '❌'} | Error`,
                        description: 'Nothing to pause',
                        color: '#ff0000'
                    });
                }
                break;
            
            case 'resume':
                if (sub.audioPlayer.unpause()) {
                    this.sendFeedback({
                        title: `${emotes.play || '▶️'} | Resumed`,
                        description: sub.currentTrack ? `Resumed: **${sub.currentTrack.title}**` : 'Playback resumed',
                        user: user,
                        color: '#ff006a'
                    });
                } else {
                    this.sendFeedback({
                        title: `${emotes.error || '❌'} | Error`,
                        description: 'Nothing to resume',
                        color: '#ff0000'
                    });
                }
                break;
            
            case 'volume': {
                const vol = parseVolumeFromText(match[1]);
                if (vol !== null && vol >= 0 && vol <= 200) {
                    sub.setVolume(vol);
                    this.sendFeedback({
                        title: `🔊 | Volume`,
                        description: `Volume set to **${vol}%**`,
                        user: user,
                        color: '#ff006a'
                    });
                } else if (vol !== null) {
                    this.sendFeedback({
                        title: `${emotes.error || '❌'} | Error`,
                        description: 'Volume must be between 0 and 200',
                        color: '#ff0000'
                    });
                } else {
                    this.sendFeedback({
                        title: `${emotes.error || '❌'} | Error`,
                        description: `Could not understand volume: "${match[1]}"`,
                        color: '#ff0000'
                    });
                }
                break;
            }
            
            case 'previous':
                try {
                    await sub.previous();
                    this.sendFeedback({
                        title: `⏮️ | Previous`,
                        description: 'Playing previous track',
                        user: user,
                        color: '#ff006a'
                    });
                } catch (e) {
                    this.sendFeedback({
                        title: `${emotes.error || '❌'} | Error`,
                        description: e.message,
                        color: '#ff0000'
                    });
                }
                break;
            
            case 'shuffle':
                if (sub.queue.length > 1) {
                    for (let i = sub.queue.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [sub.queue[i], sub.queue[j]] = [sub.queue[j], sub.queue[i]];
                    }
                    sub.scheduleQueueUpdate();
                    this.sendFeedback({
                        title: `🔀 | Shuffled`,
                        description: `Shuffled **${sub.queue.length}** tracks in the queue`,
                        user: user,
                        color: '#ff006a'
                    });
                } else {
                    this.sendFeedback({
                        title: `${emotes.error || '❌'} | Error`,
                        description: 'Not enough tracks to shuffle',
                        color: '#ff0000'
                    });
                }
                break;
            
            case 'queue':
                if (sub.queue.length === 0 && !sub.currentTrack) {
                    this.sendFeedback({
                        title: `📋 | Queue`,
                        description: 'The queue is empty',
                        color: '#ff006a'
                    });
                } else {
                    const lines = [];
                    if (sub.currentTrack) {
                        lines.push(`**Now Playing:** ${sub.currentTrack.title}`);
                    }
                    if (sub.queue.length > 0) {
                        lines.push(`\n**Up Next:**`);
                        sub.queue.slice(0, 5).forEach((t, i) => {
                            lines.push(`${i + 1}. ${t.title}`);
                        });
                        if (sub.queue.length > 5) {
                            lines.push(`*...and ${sub.queue.length - 5} more*`);
                        }
                    }
                    this.sendFeedback({
                        title: `📋 | Queue (${sub.queue.length} tracks)`,
                        description: lines.join('\n'),
                        color: '#ff006a'
                    });
                }
                break;
        }
    }
    
    /**
     * Send feedback message to text channel using embeds
     */
    sendFeedback(options) {
        if (!this.textChannel) return;
        
        const { EmbedBuilder } = require('discord.js');
        
        // If it's a simple string, convert to embed
        if (typeof options === 'string') {
            const embed = new EmbedBuilder()
                .setDescription(`🎤 ${options}`)
                .setColor('#9B59B6') // Purple for voice commands
                .setFooter({ text: 'Voice Command', iconURL: this.client.logo });
            
            this.textChannel.send({ embeds: [embed] }).catch((e) => {
                logger.debug(`Failed to send feedback: ${e.message}`);
            });
            return;
        }
        
        // Otherwise, build a proper embed
        const embed = new EmbedBuilder()
            .setColor(options.color || '#9B59B6')
            .setFooter({ text: '🎤 Voice Command', iconURL: this.client.logo });
        
        if (options.title) embed.setTitle(options.title);
        if (options.url) embed.setURL(options.url);
        if (options.description) embed.setDescription(options.description);
        if (options.thumbnail) embed.setThumbnail(options.thumbnail);
        if (options.fields) embed.addFields(options.fields);
        if (options.user) {
            embed.setAuthor({ 
                name: `${options.user.username || options.user.toString()}`, 
                iconURL: options.user.displayAvatarURL?.() || undefined 
            });
        }
        
        this.textChannel.send({ embeds: [embed] }).catch((e) => {
            logger.debug(`Failed to send feedback: ${e.message}`);
        });
    }
    
    /**
     * Clean up resources for a user
     */
    cleanupUser(userId) {
        const pcmStream = this.pcmConverters.get(userId);
        if (pcmStream) {
            pcmStream.destroy();
            this.pcmConverters.delete(userId);
        }
        
        this.audioStreams.delete(userId);
        
        if (this.currentSpeakingUser === userId) {
            this.currentSpeakingUser = null;
        }
    }
    
    /**
     * Stop listening for voice commands
     * @param {boolean} silent - If true, don't send notification message
     */
    stop(silent = false) {
        this.enabled = false;
        
        // Clear pending wake phrase
        this.clearPendingWake();
        
        // Close Deepgram connection
        if (this.liveConnection) {
            try {
                this.liveConnection.finish();
            } catch {}
            this.liveConnection = null;
        }
        
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }

        if (this.receiver && this._onSpeakingStart) {
            this.receiver.speaking.off('start', this._onSpeakingStart);
            this.receiver.speaking.off('end', this._onSpeakingEnd);
            this._onSpeakingStart = null;
            this._onSpeakingEnd = null;
            this.receiver = null;
        }
        
        // Clean up streams
        for (const [userId, pcmStream] of this.pcmConverters) {
            pcmStream.destroy();
        }
        this.pcmConverters.clear();
        this.audioStreams.clear();
        
        logger.info('Voice command listener stopped');
    }
    
    /**
     * Clean up resources
     */
    destroy() {
        this.stop();
    }
}

module.exports = VoiceCommandListener;
