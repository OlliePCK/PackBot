const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const logger = require('../logger');

// Detect platform from URL
function detectPlatform(url) {
    if (url.includes('spotify.com')) return 'spotify';
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('soundcloud.com')) return 'soundcloud';
    return 'other';
}

// Platform emojis
const PLATFORM_EMOJI = {
    spotify: '🟢',
    youtube: '🔴',
    soundcloud: '🟠',
    other: '🔗'
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playlist')
        .setDescription('Save and manage your favorite playlists')
        .addSubcommand(sub =>
            sub.setName('save')
                .setDescription('Save a playlist for quick access')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('A short name for this playlist (e.g., "chill", "workout")')
                        .setRequired(true)
                        .setMaxLength(50)
                )
                .addStringOption(opt =>
                    opt.setName('url')
                        .setDescription('The playlist URL (Spotify, YouTube, SoundCloud)')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('play')
                .setDescription('Play one of your saved playlists')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Name of the saved playlist')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all your saved playlists')
        )
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a saved playlist')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Name of the playlist to remove')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        ),

    // Handle autocomplete for playlist names
    async autocomplete(interaction) {
        const focusedValue = interaction.options.getFocused().toLowerCase();
        
        try {
            const [rows] = await db.pool.query(
                'SELECT name, platform FROM SavedPlaylists WHERE guildId = ? AND userId = ? ORDER BY name',
                [interaction.guildId, interaction.user.id]
            );
            
            const filtered = rows
                .filter(row => row.name.toLowerCase().includes(focusedValue))
                .slice(0, 25)
                .map(row => ({
                    name: `${PLATFORM_EMOJI[row.platform] || '🔗'} ${row.name}`,
                    value: row.name
                }));
            
            await interaction.respond(filtered);
        } catch (error) {
            logger.error('Playlist autocomplete error', { error: error.message });
            await interaction.respond([]);
        }
    },

    async execute(interaction, guildProfile) {
        const sub = interaction.options.getSubcommand();
        const client = interaction.client;

        // ========== SAVE ==========
        if (sub === 'save') {
            const name = interaction.options.getString('name').toLowerCase().trim();
            const url = interaction.options.getString('url').trim();
            
            // Validate URL format
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                const embed = new EmbedBuilder()
                    .setDescription(`${client.emotes.error} | Please provide a valid URL.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: client.logo });
                return interaction.editReply({ embeds: [embed] });
            }
            
            // Validate name
            if (!/^[a-z0-9_-]+$/.test(name)) {
                const embed = new EmbedBuilder()
                    .setDescription(`${client.emotes.error} | Playlist name can only contain letters, numbers, dashes, and underscores.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: client.logo });
                return interaction.editReply({ embeds: [embed] });
            }
            
            const platform = detectPlatform(url);
            
            try {
                // Check if user already has max playlists (limit: 25)
                const [countRows] = await db.pool.query(
                    'SELECT COUNT(*) as count FROM SavedPlaylists WHERE guildId = ? AND userId = ?',
                    [interaction.guildId, interaction.user.id]
                );
                
                if (countRows[0].count >= 25) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${client.emotes.error} | You've reached the maximum of 25 saved playlists. Remove one first.`)
                        .setColor('#ff0000')
                        .setFooter({ text: 'The Pack', iconURL: client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }
                
                // Insert or update
                await db.pool.query(
                    `INSERT INTO SavedPlaylists (guildId, userId, name, url, platform) 
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE url = VALUES(url), platform = VALUES(platform)`,
                    [interaction.guildId, interaction.user.id, name, url, platform]
                );
                
                const embed = new EmbedBuilder()
                    .setTitle(`${client.emotes.success} | Playlist Saved!`)
                    .setDescription(`You can now play this playlist anytime with:\n\`/playlist play ${name}\``)
                    .addFields(
                        { name: 'Name', value: `\`${name}\``, inline: true },
                        { name: 'Platform', value: `${PLATFORM_EMOJI[platform]} ${platform}`, inline: true }
                    )
                    .setColor('#00ff00')
                    .setFooter({ text: 'The Pack', iconURL: client.logo });
                
                return interaction.editReply({ embeds: [embed] });
                
            } catch (error) {
                logger.error('Failed to save playlist', { error: error.message });
                const embed = new EmbedBuilder()
                    .setDescription(`${client.emotes.error} | Failed to save playlist. Please try again.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: client.logo });
                return interaction.editReply({ embeds: [embed] });
            }
        }

        // ========== PLAY ==========
        if (sub === 'play') {
            const name = interaction.options.getString('name').toLowerCase().trim();
            
            try {
                const [rows] = await db.pool.query(
                    'SELECT url, platform FROM SavedPlaylists WHERE guildId = ? AND userId = ? AND name = ?',
                    [interaction.guildId, interaction.user.id, name]
                );
                
                if (rows.length === 0) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${client.emotes.error} | No playlist found with name \`${name}\`.\nUse \`/playlist list\` to see your saved playlists.`)
                        .setColor('#ff0000')
                        .setFooter({ text: 'The Pack', iconURL: client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }
                
                const playlist = rows[0];
                
                // Get the play command and execute it with the URL
                const playCommand = client.commands.get('play');
                if (!playCommand) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${client.emotes.error} | Play command not found.`)
                        .setColor('#ff0000')
                        .setFooter({ text: 'The Pack', iconURL: client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }
                
                // Override the options to inject our saved URL
                const originalGetString = interaction.options.getString.bind(interaction.options);
                interaction.options.getString = (optionName) => {
                    if (optionName === 'song') return playlist.url;
                    return originalGetString(optionName);
                };
                
                // Execute play command with our URL
                return playCommand.execute(interaction, guildProfile);
                
            } catch (error) {
                logger.error('Failed to play saved playlist', { error: error.message });
                const embed = new EmbedBuilder()
                    .setDescription(`${client.emotes.error} | Failed to play playlist. Please try again.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: client.logo });
                return interaction.editReply({ embeds: [embed] });
            }
        }

        // ========== LIST ==========
        if (sub === 'list') {
            try {
                const [rows] = await db.pool.query(
                    'SELECT name, url, platform, createdAt FROM SavedPlaylists WHERE guildId = ? AND userId = ? ORDER BY name',
                    [interaction.guildId, interaction.user.id]
                );
                
                if (rows.length === 0) {
                    const embed = new EmbedBuilder()
                        .setTitle('📋 Your Saved Playlists')
                        .setDescription('You don\'t have any saved playlists yet.\n\nSave one with:\n`/playlist save <name> <url>`')
                        .setColor('#ff006a')
                        .setFooter({ text: 'The Pack', iconURL: client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }
                
                const playlistList = rows.map((row, index) => {
                    const emoji = PLATFORM_EMOJI[row.platform] || '🔗';
                    return `${emoji} **${row.name}** - [Link](${row.url})`;
                }).join('\n');
                
                const embed = new EmbedBuilder()
                    .setTitle(`📋 Your Saved Playlists (${rows.length}/25)`)
                    .setDescription(playlistList)
                    .setColor('#ff006a')
                    .setFooter({ text: 'The Pack • Use /playlist play <name> to play', iconURL: client.logo });
                
                return interaction.editReply({ embeds: [embed] });
                
            } catch (error) {
                logger.error('Failed to list playlists', { error: error.message });
                const embed = new EmbedBuilder()
                    .setDescription(`${client.emotes.error} | Failed to load playlists. Please try again.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: client.logo });
                return interaction.editReply({ embeds: [embed] });
            }
        }

        // ========== REMOVE ==========
        if (sub === 'remove') {
            const name = interaction.options.getString('name').toLowerCase().trim();
            
            try {
                const [result] = await db.pool.query(
                    'DELETE FROM SavedPlaylists WHERE guildId = ? AND userId = ? AND name = ?',
                    [interaction.guildId, interaction.user.id, name]
                );
                
                if (result.affectedRows === 0) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${client.emotes.error} | No playlist found with name \`${name}\`.`)
                        .setColor('#ff0000')
                        .setFooter({ text: 'The Pack', iconURL: client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }
                
                const embed = new EmbedBuilder()
                    .setDescription(`${client.emotes.success} | Playlist \`${name}\` has been removed.`)
                    .setColor('#00ff00')
                    .setFooter({ text: 'The Pack', iconURL: client.logo });
                
                return interaction.editReply({ embeds: [embed] });
                
            } catch (error) {
                logger.error('Failed to remove playlist', { error: error.message });
                const embed = new EmbedBuilder()
                    .setDescription(`${client.emotes.error} | Failed to remove playlist. Please try again.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: client.logo });
                return interaction.editReply({ embeds: [embed] });
            }
        }
    },
};
