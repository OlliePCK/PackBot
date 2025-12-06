// Shared state for the Music Taste Correction System™
// This allows the /troll command to modify the state used by /play

module.exports = {
    enabled: true, // Toggle this to enable/disable globally
    users: {
        '123000535606362113': {
            replacement: 'https://www.youtube.com/watch?v=x1PQu2PmYKQ',
        }
    },
    // Random alternatives (used if replacement is null)
    alternatives: [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ', // Never Gonna Give You Up
        'https://www.youtube.com/watch?v=Lrj2Hq7xqQ8', // Careless Whisper
        'https://www.youtube.com/watch?v=y6120QOlsfU', // Sandstorm
        'https://www.youtube.com/watch?v=9bZkp7q19f0', // Gangnam Style
    ]
};
