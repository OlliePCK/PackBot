const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database/db.js');
const logger = require('../logger');

// Format seconds into readable time
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

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('View playtime leaderboards')
        .addSubcommand(sub =>
            sub.setName('total')
                .setDescription('Top 10 users by total playtime across all games')
        )
        .addSubcommand(sub =>
            sub.setName('game')
                .setDescription('Top 10 users for a specific game')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('The game name to check')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('user')
                .setDescription('View a user\'s playtime stats')
                .addUserOption(opt =>
                    opt.setName('member')
                        .setDescription('The user to check (defaults to yourself)')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('games')
                .setDescription('Top 10 most played games in this server')
        ),

    async autocomplete(interaction) {
        const focusedValue = interaction.options.getFocused().toLowerCase();
        
        try {
            // Get popular games from the database for this guild
            const [rows] = await db.pool.query(`
                SELECT DISTINCT gameName 
                FROM Playtime 
                WHERE guildId = ? AND gameName LIKE ?
                ORDER BY totalSeconds DESC
                LIMIT 25
            `, [interaction.guildId, `%${focusedValue}%`]);
            
            const choices = rows.map(row => ({
                name: row.gameName.substring(0, 100),
                value: row.gameName.substring(0, 100)
            }));
            
            await interaction.respond(choices);
        } catch (e) {
            await interaction.respond([]);
        }
    },

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === 'total') {
                // Top 10 users by total playtime
                const [rows] = await db.pool.query(`
                    SELECT odUserId, odUsername, SUM(totalSeconds) as total
                    FROM Playtime
                    WHERE guildId = ?
                    GROUP BY odUserId, odUsername
                    ORDER BY total DESC
                    LIMIT 10
                `, [interaction.guildId]);

                if (rows.length === 0) {
                    const embed = new EmbedBuilder()
                        .setDescription('📊 No playtime data recorded yet!')
                        .setColor('#ff006a')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }

                const leaderboard = rows.map((row, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
                    return `${medal} <@${row.odUserId}> — ${formatTime(row.total)}`;
                }).join('\n');

                const embed = new EmbedBuilder()
                    .setTitle('🎮 Total Playtime Leaderboard')
                    .setDescription(leaderboard)
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                    .setColor('#ff006a')
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });

            } else if (subcommand === 'game') {
                const gameName = interaction.options.getString('name');
                
                const [rows] = await db.pool.query(`
                    SELECT odUserId, odUsername, totalSeconds
                    FROM Playtime
                    WHERE guildId = ? AND gameName = ?
                    ORDER BY totalSeconds DESC
                    LIMIT 10
                `, [interaction.guildId, gameName]);

                if (rows.length === 0) {
                    const embed = new EmbedBuilder()
                        .setDescription(`📊 No playtime data for **${gameName}** yet!`)
                        .setColor('#ff006a')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }

                const leaderboard = rows.map((row, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
                    return `${medal} <@${row.odUserId}> — ${formatTime(row.totalSeconds)}`;
                }).join('\n');

                const embed = new EmbedBuilder()
                    .setTitle(`🎮 ${gameName} Leaderboard`)
                    .setDescription(leaderboard)
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                    .setColor('#ff006a')
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });

            } else if (subcommand === 'user') {
                const user = interaction.options.getUser('member') || interaction.user;
                
                const [rows] = await db.pool.query(`
                    SELECT gameName, totalSeconds, lastPlayed
                    FROM Playtime
                    WHERE guildId = ? AND odUserId = ?
                    ORDER BY totalSeconds DESC
                    LIMIT 10
                `, [interaction.guildId, user.id]);

                if (rows.length === 0) {
                    const embed = new EmbedBuilder()
                        .setDescription(`📊 No playtime data for ${user.tag} yet!`)
                        .setColor('#ff006a')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }

                // Calculate total time
                const totalTime = rows.reduce((sum, row) => sum + row.totalSeconds, 0);

                const gameList = rows.map((row, i) => {
                    return `**${i + 1}.** ${row.gameName} — ${formatTime(row.totalSeconds)}`;
                }).join('\n');

                const embed = new EmbedBuilder()
                    .setTitle(`🎮 ${user.tag}'s Playtime`)
                    .setThumbnail(user.displayAvatarURL())
                    .addFields(
                        { name: 'Total Playtime', value: formatTime(totalTime), inline: true },
                        { name: 'Games Tracked', value: rows.length.toString(), inline: true }
                    )
                    .setDescription(`**Top Games:**\n${gameList}`)
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                    .setColor('#ff006a')
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });

            } else if (subcommand === 'games') {
                // Top 10 most played games
                const [rows] = await db.pool.query(`
                    SELECT gameName, SUM(totalSeconds) as total, COUNT(DISTINCT odUserId) as players
                    FROM Playtime
                    WHERE guildId = ?
                    GROUP BY gameName
                    ORDER BY total DESC
                    LIMIT 10
                `, [interaction.guildId]);

                if (rows.length === 0) {
                    const embed = new EmbedBuilder()
                        .setDescription('📊 No playtime data recorded yet!')
                        .setColor('#ff006a')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }

                const gameList = rows.map((row, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
                    return `${medal} **${row.gameName}** — ${formatTime(row.total)} (${row.players} players)`;
                }).join('\n');

                const embed = new EmbedBuilder()
                    .setTitle('🎮 Most Played Games')
                    .setDescription(gameList)
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                    .setColor('#ff006a')
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });
            }

        } catch (e) {
            logger.error('Leaderboard error: ' + (e.stack || e));
            
            if (e.code === 'ER_NO_SUCH_TABLE') {
                const embed = new EmbedBuilder()
                    .setDescription('📊 Playtime tracking is being set up. Please try again later!')
                    .setColor('#ffaa00')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [embed] });
            }
            
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | An error occurred while fetching the leaderboard.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }
    },
};
