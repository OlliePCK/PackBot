const { EmbedBuilder } = require('discord.js');
const logger = require('../../logger').child('music');
const db = require('../../database/db.js');

module.exports = {
    name: 'voiceStateUpdate',
    async execute(oldState, newState) {
        // Only care about users leaving a channel
        if (!oldState.channel) return;
        // Don't care if user just switched channels within same channel (mute/deafen)
        if (oldState.channelId === newState.channelId) return;

        const client = oldState.client;
        const subscription = client.subscriptions.get(oldState.guild.id);
        
        if (!subscription) return;

        // Get the channel the BOT is in, not the channel the user left
        const botChannel = subscription.voiceConnection?.joinConfig?.channelId;
        if (!botChannel) return;
        
        // Only care if the user left the SAME channel the bot is in
        if (oldState.channelId !== botChannel) return;

        // Check members in the bot's channel (not oldState.channel which might be stale)
        const guild = oldState.guild;
        const channel = guild.channels.cache.get(botChannel);
        if (!channel) return;
        
        const members = channel.members.filter(m => !m.user.bot);
        if (members.size === 0) {
            // Check if 24/7 mode is enabled for this guild
            try {
                const [rows] = await db.pool.query(
                    'SELECT twentyFourSevenMode FROM Guilds WHERE guildId = ?',
                    [oldState.guild.id]
                );
                
                if (rows.length > 0 && rows[0].twentyFourSevenMode) {
                    logger.info('No listeners but 24/7 mode enabled, staying in channel', { 
                        guild: oldState.guild.id, 
                        channel: oldState.channel.name 
                    });
                    return; // Don't leave if 24/7 mode is on
                }
            } catch (err) {
                logger.error('Failed to check 24/7 mode', { error: err.message });
            }
            
            logger.info('No listeners remaining, leaving channel', { guild: oldState.guild.id, channel: oldState.channel.name });
            
            const embed = new EmbedBuilder()
                .setTitle(`${client.emotes.success} | No one listening, leaving the channel!`)
                .setDescription('Thank you for using The Pack music bot.')
                .setFooter({ text: 'The Pack', iconURL: client.logo })
                .setColor('#ff006a');

            try {
                // Use the channel where music commands were used, not just any text channel
                const textChannel = subscription._textChannel;
                if (textChannel) {
                    await textChannel.send({ embeds: [embed] });
                }
            } catch (err) {
                logger.error('Failed to send leave message', { error: err.message });
            }

            try {
                subscription.voiceConnection.destroy();
                client.subscriptions.delete(oldState.guild.id);
            } catch (err) {
                logger.error('Failed to leave voice channel', { error: err.message });
            }
        }
    },
};
