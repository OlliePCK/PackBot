const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

/**
 * Create a visual progress bar for track playback
 * @param {number} current - Current time in seconds
 * @param {number} total - Total duration in seconds
 * @param {number} length - Length of the progress bar in characters
 * @returns {string} Progress bar string
 */
function createProgressBar(current, total, length = 20) {
    if (!total || total <= 0) return '─'.repeat(length);
    
    const progress = Math.min(current / total, 1);
    const filledLength = Math.round(progress * length);
    
    const filled = '─'.repeat(Math.max(0, filledLength));
    const empty = '─'.repeat(Math.max(0, length - filledLength - 1));
    const position = '●';
    
    return `${filled}${position}${empty}`;
}

/**
 * Format seconds to MM:SS or HH:MM:SS
 * @param {number} seconds 
 * @returns {string}
 */
function formatTime(seconds) {
    if (!seconds || seconds <= 0) return '0:00';
    
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Get repeat mode display string
 * @param {number} mode - 0: off, 1: song, 2: queue
 * @param {object} emotes - Client emotes
 * @returns {string}
 */
function getRepeatDisplay(mode, emotes) {
    switch (mode) {
        case 1: return `${emotes.repeat || '🔁'} Song`;
        case 2: return `${emotes.repeat || '🔁'} Queue`;
        default: return 'Off';
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nowplaying')
        .setDescription('Show the currently playing track with progress'),

    async execute(interaction) {
        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        
        if (!subscription || !subscription.currentTrack) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Nothing is currently playing.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        const track = subscription.currentTrack;
        const emotes = interaction.client.emotes;
        
        // Calculate current playback position
        let currentTime = 0;
        if (subscription.playbackStartTime) {
            currentTime = Math.floor((Date.now() - subscription.playbackStartTime) / 1000);
        }
        
        // Clamp to track duration
        const totalTime = track.duration || 0;
        currentTime = Math.min(currentTime, totalTime);
        
        // Build progress bar
        const progressBar = createProgressBar(currentTime, totalTime);
        const timeDisplay = `${formatTime(currentTime)} / ${formatTime(totalTime)}`;
        
        // Build embed
        const embed = new EmbedBuilder()
            .setTitle(`${emotes.play || '▶️'} Now Playing`)
            .setDescription(`**[${track.title}](${track.url || ''})**\nby ${track.artist || 'Unknown Artist'}`)
            .addFields(
                { 
                    name: 'Progress', 
                    value: `\`${progressBar}\`\n\`${timeDisplay}\``, 
                    inline: false 
                },
                { name: 'Volume', value: `\`${subscription.volume}%\``, inline: true },
                { name: 'Loop', value: getRepeatDisplay(subscription.repeatMode, emotes), inline: true },
                { name: 'Requested by', value: `${track.requestedBy}`, inline: true }
            )
            .setColor('#ff006a')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        
        // Add thumbnail if available
        if (track.thumbnail) {
            embed.setThumbnail(track.thumbnail);
        }
        
        // Add queue info
        if (subscription.queue.length > 0) {
            const nextTrack = subscription.queue[0];
            embed.addFields({
                name: `Up Next (${subscription.queue.length} in queue)`,
                value: `${nextTrack.title}`,
                inline: false
            });
        }
        
        // Add special status indicators
        const statusParts = [];
        if (subscription.autoplay) statusParts.push('🔄 Autoplay');
        if (subscription.filters.length > 0) statusParts.push(`🎛️ ${subscription.filters.length} filter(s)`);
        if (subscription.voiceCommandsEnabled) statusParts.push('🎤 Voice');
        
        if (statusParts.length > 0) {
            embed.addFields({
                name: 'Status',
                value: statusParts.join(' • '),
                inline: false
            });
        }

        return interaction.editReply({ embeds: [embed] });
    },
};
