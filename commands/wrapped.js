const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database/db.js');
const logger = require('../logger');

function formatTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        return `${days}d ${remainingHours}h ${minutes}m`;
    }
    return `${hours}h ${minutes}m`;
}

function formatHour(hour) {
    if (hour === 0) return '12 AM';
    if (hour === 12) return '12 PM';
    return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('wrapped')
        .setDescription('View music listening stats')
        .addSubcommand(sub =>
            sub.setName('me')
                .setDescription('Your personal music stats')
        )
        .addSubcommand(sub =>
            sub.setName('server')
                .setDescription('Server-wide music stats')
        )
        .addSubcommand(sub =>
            sub.setName('compare')
                .setDescription('Compare music taste with another user')
                .addUserOption(opt =>
                    opt.setName('user')
                        .setDescription('User to compare with')
                        .setRequired(true)
                )
        ),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const emotes = interaction.client.emotes;

        try {
            if (subcommand === 'me') {
                await handleMe(interaction, emotes);
            } else if (subcommand === 'server') {
                await handleServer(interaction, emotes);
            } else if (subcommand === 'compare') {
                await handleCompare(interaction, emotes);
            }
        } catch (e) {
            logger.error('Wrapped command error', { error: e.message, stack: e.stack });
            const embed = new EmbedBuilder()
                .setDescription(`${emotes.error} | Something went wrong fetching stats.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }
    },
};

async function handleMe(interaction, emotes) {
    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    const [[stats]] = await db.pool.query(
        `SELECT COUNT(*) as totalTracks,
                COALESCE(SUM(durationSeconds), 0) as totalSeconds,
                COUNT(DISTINCT CONCAT(trackTitle, trackArtist)) as uniqueTracks
         FROM ListeningHistory WHERE guildId = ? AND odUserId = ?`,
        [guildId, userId]
    );

    if (parseInt(stats.totalTracks) === 0) {
        const embed = new EmbedBuilder()
            .setDescription(`${emotes.error} | No listening data found for you in this server yet!`)
            .setColor('#ff0000')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        return interaction.editReply({ embeds: [embed] });
    }

    const [topTracks] = await db.pool.query(
        `SELECT trackTitle as title, trackArtist as artist, COUNT(*) as playCount
         FROM ListeningHistory WHERE guildId = ? AND odUserId = ?
         GROUP BY trackTitle, trackArtist ORDER BY playCount DESC LIMIT 5`,
        [guildId, userId]
    );

    const [topArtists] = await db.pool.query(
        `SELECT trackArtist as artist, COUNT(*) as playCount
         FROM ListeningHistory WHERE guildId = ? AND odUserId = ? AND trackArtist IS NOT NULL
         GROUP BY trackArtist ORDER BY playCount DESC LIMIT 5`,
        [guildId, userId]
    );

    const [favoriteHour] = await db.pool.query(
        `SELECT HOUR(playedAt) as hour, COUNT(*) as count
         FROM ListeningHistory WHERE guildId = ? AND odUserId = ?
         GROUP BY HOUR(playedAt) ORDER BY count DESC LIMIT 1`,
        [guildId, userId]
    );

    const tracksText = topTracks.map((t, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
        return `${medal} **${t.title}** — ${t.artist || 'Unknown'} (${t.playCount} plays)`;
    }).join('\n');

    const artistsText = topArtists.map((a, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
        return `${medal} **${a.artist}** (${a.playCount} plays)`;
    }).join('\n');

    const embed = new EmbedBuilder()
        .setTitle(`🎧 ${interaction.user.username}'s Music Wrapped`)
        .setThumbnail(interaction.user.displayAvatarURL())
        .addFields(
            { name: 'Total Listening Time', value: formatTime(stats.totalSeconds), inline: true },
            { name: 'Tracks Played', value: `${stats.totalTracks}`, inline: true },
            { name: 'Unique Tracks', value: `${stats.uniqueTracks}`, inline: true },
            { name: '🎵 Top Tracks', value: tracksText || 'No data', inline: false },
            { name: '🎤 Top Artists', value: artistsText || 'No data', inline: false }
        )
        .setColor('#ff006a')
        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
        .setTimestamp();

    if (favoriteHour.length > 0) {
        embed.addFields({
            name: '⏰ Peak Listening Hour',
            value: formatHour(favoriteHour[0].hour),
            inline: true
        });
    }

    return interaction.editReply({ embeds: [embed] });
}

async function handleServer(interaction, emotes) {
    const guildId = interaction.guildId;

    const [[stats]] = await db.pool.query(
        `SELECT COUNT(*) as totalTracks,
                COALESCE(SUM(durationSeconds), 0) as totalSeconds,
                COUNT(DISTINCT trackArtist) as uniqueArtists
         FROM ListeningHistory WHERE guildId = ?`,
        [guildId]
    );

    if (parseInt(stats.totalTracks) === 0) {
        const embed = new EmbedBuilder()
            .setDescription(`${emotes.error} | No listening data found for this server yet!`)
            .setColor('#ff0000')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        return interaction.editReply({ embeds: [embed] });
    }

    const [topTracks] = await db.pool.query(
        `SELECT trackTitle as title, trackArtist as artist, COUNT(*) as playCount
         FROM ListeningHistory WHERE guildId = ?
         GROUP BY trackTitle, trackArtist ORDER BY playCount DESC LIMIT 5`,
        [guildId]
    );

    const [topListeners] = await db.pool.query(
        `SELECT odUserId, COALESCE(SUM(durationSeconds), 0) as totalSeconds, COUNT(*) as playCount
         FROM ListeningHistory WHERE guildId = ?
         GROUP BY odUserId ORDER BY totalSeconds DESC LIMIT 5`,
        [guildId]
    );

    const tracksText = topTracks.map((t, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
        return `${medal} **${t.title}** — ${t.artist || 'Unknown'} (${t.playCount} plays)`;
    }).join('\n');

    const listenersText = topListeners.map((l, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
        return `${medal} <@${l.odUserId}> — ${formatTime(l.totalSeconds)} (${l.playCount} plays)`;
    }).join('\n');

    const embed = new EmbedBuilder()
        .setTitle(`🎧 ${interaction.guild.name} Music Wrapped`)
        .setThumbnail(interaction.guild.iconURL())
        .addFields(
            { name: 'Total Listening Time', value: formatTime(stats.totalSeconds), inline: true },
            { name: 'Tracks Played', value: `${stats.totalTracks}`, inline: true },
            { name: 'Unique Artists', value: `${stats.uniqueArtists}`, inline: true },
            { name: '🎵 Top Tracks', value: tracksText || 'No data', inline: false },
            { name: '👑 Top Listeners', value: listenersText || 'No data', inline: false }
        )
        .setColor('#ff006a')
        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

async function handleCompare(interaction, emotes) {
    const guildId = interaction.guildId;
    const otherUser = interaction.options.getUser('user');

    if (otherUser.id === interaction.user.id) {
        const embed = new EmbedBuilder()
            .setDescription(`${emotes.error} | You can't compare with yourself!`)
            .setColor('#ff0000')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        return interaction.editReply({ embeds: [embed] });
    }

    // Get top 50 tracks and 30 artists for each user
    const getUserData = async (uid) => {
        const [tracks] = await db.pool.query(
            `SELECT trackTitle as title, trackArtist as artist, COUNT(*) as playCount
             FROM ListeningHistory WHERE guildId = ? AND odUserId = ?
             GROUP BY trackTitle, trackArtist ORDER BY playCount DESC LIMIT 50`,
            [guildId, uid]
        );
        const [artists] = await db.pool.query(
            `SELECT trackArtist as artist, COUNT(*) as playCount
             FROM ListeningHistory WHERE guildId = ? AND odUserId = ? AND trackArtist IS NOT NULL
             GROUP BY trackArtist ORDER BY playCount DESC LIMIT 30`,
            [guildId, uid]
        );
        const [[stats]] = await db.pool.query(
            `SELECT COUNT(*) as totalTracks, COALESCE(SUM(durationSeconds), 0) as totalSeconds
             FROM ListeningHistory WHERE guildId = ? AND odUserId = ?`,
            [guildId, uid]
        );
        return { tracks, artists, stats };
    };

    const [u1, u2] = await Promise.all([
        getUserData(interaction.user.id),
        getUserData(otherUser.id)
    ]);

    if (parseInt(u1.stats.totalTracks) === 0 || parseInt(u2.stats.totalTracks) === 0) {
        const embed = new EmbedBuilder()
            .setDescription(`${emotes.error} | Both users need listening history to compare.`)
            .setColor('#ff0000')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        return interaction.editReply({ embeds: [embed] });
    }

    // Compute shared artists
    const artists1 = new Set(u1.artists.map(a => a.artist.toLowerCase()));
    const artists2 = new Set(u2.artists.map(a => a.artist.toLowerCase()));
    const sharedArtists = [...artists1].filter(a => artists2.has(a));

    // Compute shared tracks
    const tracks1 = new Set(u1.tracks.map(t => `${t.title}::${t.artist}`.toLowerCase()));
    const tracks2 = new Set(u2.tracks.map(t => `${t.title}::${t.artist}`.toLowerCase()));
    const sharedTracks = [...tracks1].filter(t => tracks2.has(t));

    const minArtists = Math.min(artists1.size, artists2.size);
    const compatibility = minArtists > 0 ? Math.round((sharedArtists.length / minArtists) * 100) : 0;

    // Pick emoji for compatibility level
    let compatEmoji = '💔';
    if (compatibility >= 80) compatEmoji = '❤️‍🔥';
    else if (compatibility >= 60) compatEmoji = '💖';
    else if (compatibility >= 40) compatEmoji = '💛';
    else if (compatibility >= 20) compatEmoji = '💙';

    const sharedArtistsText = sharedArtists.length > 0
        ? sharedArtists.slice(0, 10).join(', ')
        : 'None';

    const embed = new EmbedBuilder()
        .setTitle(`${compatEmoji} Music Compatibility: ${compatibility}%`)
        .setDescription(`**${interaction.user.username}** vs **${otherUser.username}**`)
        .addFields(
            { name: `${interaction.user.username}`, value: `${formatTime(u1.stats.totalSeconds)}\n${u1.stats.totalTracks} plays`, inline: true },
            { name: `${otherUser.username}`, value: `${formatTime(u2.stats.totalSeconds)}\n${u2.stats.totalTracks} plays`, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: '🎤 Shared Artists', value: sharedArtistsText, inline: false },
            { name: '📊 Stats', value: `**${sharedArtists.length}** shared artists • **${sharedTracks.length}** shared tracks`, inline: false }
        )
        .setColor('#ff006a')
        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}
