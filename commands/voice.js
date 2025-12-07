const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const logger = require('../logger');
const db = require('../database/db');

// Helper to check if guild is whitelisted for voice commands
async function isGuildWhitelisted(guildId) {
    try {
        const [rows] = await db.pool.query(
            'SELECT 1 FROM VoiceWhitelist WHERE guildId = ?',
            [guildId]
        );
        return rows.length > 0;
    } catch (error) {
        logger.error('Failed to check voice whitelist', { error: error.message });
        return false;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Toggle voice commands for the music bot')
        .addSubcommand(sub =>
            sub.setName('enable')
                .setDescription('Enable voice commands - say "Pack Bot" followed by a command')
        )
        .addSubcommand(sub =>
            sub.setName('disable')
                .setDescription('Disable voice commands (saves API costs)')
        )
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Check if voice commands are enabled')
        )
        .addSubcommand(sub =>
            sub.setName('autoenable')
                .setDescription('Toggle auto-enable voice commands when bot joins (Admin only)')
                .addBooleanOption(opt =>
                    opt.setName('enabled')
                        .setDescription('Whether to auto-enable voice commands')
                        .setRequired(true)
                )
        ),

    // Export the helper for use in other commands
    isGuildWhitelisted,

    async execute(interaction, guildProfile) {
        const sub = interaction.options.getSubcommand();
        const subscription = interaction.client.subscriptions.get(interaction.guildId);

        // Check whitelist for all subcommands except status
        if (sub !== 'status') {
            const whitelisted = await isGuildWhitelisted(interaction.guildId);
            if (!whitelisted) {
                const embed = new EmbedBuilder()
                    .setTitle('🚫 Voice Commands Unavailable')
                    .setDescription('Voice commands are only available for whitelisted servers.\n\nThis feature uses a paid API for speech recognition.')
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [embed] });
            }
        }

        // Handle autoenable subcommand (admin only, whitelisted guilds)
        if (sub === 'autoenable') {
            // Check for admin permissions
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                const embed = new EmbedBuilder()
                    .setDescription(`${interaction.client.emotes.error} | You need Administrator permissions to change this setting.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [embed] });
            }

            const enabled = interaction.options.getBoolean('enabled');
            
            try {
                await db.pool.query(
                    'UPDATE Guilds SET voiceCommandsEnabled = ? WHERE guildId = ?',
                    [enabled, interaction.guildId]
                );
                
                // Update the cached guild profile
                if (guildProfile) {
                    guildProfile.voiceCommandsEnabled = enabled;
                }

                logger.info(`Voice commands auto-enable set to ${enabled}`, { 
                    guild: interaction.guild.name, 
                    user: interaction.user.tag 
                });

                const embed = new EmbedBuilder()
                    .setTitle('🎤 Voice Commands Auto-Enable')
                    .setDescription(enabled 
                        ? '✅ Voice commands will now **automatically enable** when the bot joins a voice channel.\n\nUsers can still manually disable with `/voice disable` to save API costs.'
                        : '❌ Voice commands will **not** auto-enable.\n\nUsers can still manually enable with `/voice enable`.')
                    .setColor(enabled ? '#00ff00' : '#ff0000')
                    .setFooter({ text: 'The Pack • Admin Setting', iconURL: interaction.client.logo });
                
                return interaction.editReply({ embeds: [embed] });
            } catch (error) {
                logger.error('Failed to update voice commands setting', { error: error.message });
                const embed = new EmbedBuilder()
                    .setDescription(`${interaction.client.emotes.error} | Failed to update setting. Please try again.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [embed] });
            }
        }

        if (sub === 'status') {
            const enabled = subscription?.voiceCommandsEnabled || false;
            const autoEnabled = guildProfile?.voiceCommandsEnabled || false;
            const whitelisted = await isGuildWhitelisted(interaction.guildId);
            
            const embed = new EmbedBuilder()
                .setTitle('🎤 Voice Commands Status')
                .setColor(enabled ? '#00ff00' : '#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

            if (!whitelisted) {
                embed.setDescription('🚫 This server is **not whitelisted** for voice commands.\n\nVoice commands are a premium feature available to select servers.');
            } else {
                embed.setDescription(enabled 
                    ? '✅ Voice commands are **enabled**\n\nSay "**Pack Bot**" followed by a command:\n• `play [song]` - Play a song\n• `skip` / `next` - Skip current track\n• `stop` - Stop playback\n• `pause` / `resume` - Pause/resume\n• `volume [0-200]` - Set volume\n• `previous` - Play previous track\n• `shuffle` - Shuffle queue'
                    : '❌ Voice commands are **disabled**\n\nUse `/voice enable` to turn them on.')
                .addFields(
                    { name: 'Whitelisted', value: '✅ Yes', inline: true },
                    { name: 'Auto-Enable on Join', value: autoEnabled ? '✅ Enabled' : '❌ Disabled', inline: true }
                );
            }
            
            return interaction.editReply({ embeds: [embed] });
        }

        // For enable/disable, user must be in a voice channel
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | You need to be in a voice channel to use voice commands!`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        if (sub === 'enable') {
            if (!subscription) {
                const embed = new EmbedBuilder()
                    .setDescription(`${interaction.client.emotes.error} | The bot must be playing music first. Use \`/play\` to start.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [embed] });
            }

            if (subscription.voiceCommandsEnabled) {
                const embed = new EmbedBuilder()
                    .setDescription(`✅ Voice commands are already enabled!`)
                    .setColor('#00ff00')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [embed] });
            }

            const success = await subscription.enableVoiceCommands(interaction.channel, interaction.client);
            
            if (success) {
                logger.info(`Voice commands enabled`, { guild: interaction.guild.name, user: interaction.user.tag });
                
                const embed = new EmbedBuilder()
                    .setTitle('🎤 Voice Commands Enabled!')
                    .setDescription('Say "**Pack Bot**" followed by a command:\n\n• `play [song]` - Play a song\n• `skip` / `next` - Skip current track\n• `stop` - Stop playback\n• `pause` / `resume` - Pause/resume\n• `volume [0-200]` - Set volume\n• `previous` - Play previous track\n• `shuffle` - Shuffle queue\n\n*Use `/voice disable` to turn off and save API costs.*')
                    .setColor('#00ff00')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                
                return interaction.editReply({ embeds: [embed] });
            } else {
                const errEmbed = new EmbedBuilder()
                    .setDescription(`${interaction.client.emotes.error} | Failed to enable voice commands. Please check the bot logs.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [errEmbed] });
            }
        }

        if (sub === 'disable') {
            if (!subscription || !subscription.voiceCommandsEnabled) {
                const embed = new EmbedBuilder()
                    .setDescription(`${interaction.client.emotes.error} | Voice commands are not enabled.`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [embed] });
            }

            subscription.disableVoiceCommands();
            logger.info(`Voice commands disabled`, { guild: interaction.guild.name, user: interaction.user.tag });
            
            const embed = new EmbedBuilder()
                .setDescription('🎙️ Voice commands disabled. (Deepgram API costs paused)')
                .setColor('#ff006a')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }
    }
};
