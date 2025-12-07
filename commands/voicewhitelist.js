const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database/db');
const logger = require('../logger');

// This command is only deployed to guild 773732791585865769
module.exports = {
    guildOnly: '773732791585865769',
    data: new SlashCommandBuilder()
        .setName('voicewhitelist')
        .setDescription('Manage voice commands whitelist (Owner only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Add a guild to the voice commands whitelist')
                .addStringOption(opt =>
                    opt.setName('guild_id')
                        .setDescription('The guild ID to whitelist')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Optional name for reference')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a guild from the voice commands whitelist')
                .addStringOption(opt =>
                    opt.setName('guild_id')
                        .setDescription('The guild ID to remove')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all whitelisted guilds')
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'add') {
            const guildId = interaction.options.getString('guild_id');
            const guildName = interaction.options.getString('name') || 'Unknown';

            try {
                // Validate it looks like a guild ID
                if (!/^\d{17,20}$/.test(guildId)) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${interaction.client.emotes.error} | Invalid guild ID format. Must be a Discord snowflake ID.`)
                        .setColor('#ff0000')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }

                await db.pool.query(
                    `INSERT INTO VoiceWhitelist (guildId, addedBy, guildName) 
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE guildName = VALUES(guildName)`,
                    [guildId, interaction.user.id, guildName]
                );

                logger.info(`Voice whitelist: Added guild ${guildId} (${guildName})`, {
                    addedBy: interaction.user.tag
                });

                const embed = new EmbedBuilder()
                    .setTitle('✅ Guild Whitelisted')
                    .setDescription(`Guild \`${guildId}\` has been added to the voice commands whitelist.`)
                    .addFields(
                        { name: 'Guild ID', value: guildId, inline: true },
                        { name: 'Name', value: guildName, inline: true },
                        { name: 'Added By', value: interaction.user.tag, inline: true }
                    )
                    .setColor('#00ff00')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

                return interaction.editReply({ embeds: [embed] });
            } catch (error) {
                logger.error('Failed to add guild to whitelist', { error: error.message });
                const embed = new EmbedBuilder()
                    .setDescription(`${interaction.client.emotes.error} | Failed to add guild to whitelist.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [embed] });
            }
        }

        if (sub === 'remove') {
            const guildId = interaction.options.getString('guild_id');

            try {
                const [result] = await db.pool.query(
                    'DELETE FROM VoiceWhitelist WHERE guildId = ?',
                    [guildId]
                );

                if (result.affectedRows === 0) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${interaction.client.emotes.error} | That guild was not in the whitelist.`)
                        .setColor('#ff0000')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }

                logger.info(`Voice whitelist: Removed guild ${guildId}`, {
                    removedBy: interaction.user.tag
                });

                const embed = new EmbedBuilder()
                    .setTitle('🗑️ Guild Removed')
                    .setDescription(`Guild \`${guildId}\` has been removed from the voice commands whitelist.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

                return interaction.editReply({ embeds: [embed] });
            } catch (error) {
                logger.error('Failed to remove guild from whitelist', { error: error.message });
                const embed = new EmbedBuilder()
                    .setDescription(`${interaction.client.emotes.error} | Failed to remove guild from whitelist.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [embed] });
            }
        }

        if (sub === 'list') {
            try {
                const [rows] = await db.pool.query(
                    'SELECT guildId, guildName, addedBy, addedAt FROM VoiceWhitelist ORDER BY addedAt DESC'
                );

                if (rows.length === 0) {
                    const embed = new EmbedBuilder()
                        .setDescription('📝 No guilds are whitelisted for voice commands.')
                        .setColor('#ff006a')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }

                const guildList = rows.map((row, i) => {
                    const date = new Date(row.addedAt).toLocaleDateString();
                    return `${i + 1}. **${row.guildName || 'Unknown'}**\n   ID: \`${row.guildId}\`\n   Added: ${date}`;
                }).join('\n\n');

                const embed = new EmbedBuilder()
                    .setTitle('🎤 Voice Commands Whitelist')
                    .setDescription(guildList)
                    .setColor('#ff006a')
                    .setFooter({ text: `${rows.length} guild(s) whitelisted • The Pack`, iconURL: interaction.client.logo });

                return interaction.editReply({ embeds: [embed] });
            } catch (error) {
                logger.error('Failed to list whitelisted guilds', { error: error.message });
                const embed = new EmbedBuilder()
                    .setDescription(`${interaction.client.emotes.error} | Failed to retrieve whitelist.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [embed] });
            }
        }
    }
};
