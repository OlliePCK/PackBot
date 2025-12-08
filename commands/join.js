const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const Subscription = require('../music/Subscription');
const logger = require('../logger');
const { isGuildWhitelisted } = require('./voice');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('join')
        .setDescription('Join your voice channel'),

    async execute(interaction, guildProfile) {
        const voiceChannel = interaction.member?.voice?.channel;
        if (!voiceChannel) {
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | You must be in a voice channel!`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        // Check if already in the same channel
        let subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (subscription?.voiceConnection?.joinConfig?.channelId === voiceChannel.id) {
            const embed = new EmbedBuilder()
                .setDescription(`ℹ️ Already in your voice channel!`)
                .setColor('#ffaa00')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }

        // If in a different channel, destroy old connection first
        if (subscription) {
            subscription.voiceConnection.destroy();
            interaction.client.subscriptions.delete(interaction.guildId);
        }

        try {
            // Create new connection - default to deafened, will undeafen if voice commands enabled
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: true, // Default deafened, undeafens when voice commands enabled
            });

            // Wait for connection to be ready
            await entersState(connection, VoiceConnectionStatus.Ready, 10_000);

            // Create subscription
            subscription = new Subscription(connection);
            interaction.client.subscriptions.set(interaction.guildId, subscription);

            // Auto-enable voice commands if guild has opted in AND is whitelisted
            let voiceEnabled = false;
            if (guildProfile?.voiceCommandsEnabled) {
                const whitelisted = await isGuildWhitelisted(interaction.guildId);
                if (whitelisted) {
                    const success = await subscription.enableVoiceCommands(interaction.channel, interaction.client);
                    if (success) {
                        voiceEnabled = true;
                        logger.info('Voice commands auto-enabled on join', { 
                            guild: interaction.guild.name 
                        });
                    }
                }
            }

            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.success} | Joined **${voiceChannel.name}**!`)
                .setColor('#00ff00')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

            if (voiceEnabled) {
                embed.addFields({
                    name: '🎤 Voice Commands Enabled',
                    value: 'Say "**Pack Bot**" followed by a command (play, skip, stop, pause, volume).'
                });
            }

            return interaction.editReply({ embeds: [embed] });
        } catch (error) {
            logger.error('Failed to join voice channel:', error);
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | Failed to join voice channel: ${error.message}`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }
    },
};
