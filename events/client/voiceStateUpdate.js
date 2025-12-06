const { EmbedBuilder } = require('discord.js');
const logger = require('../../logger').child('music');

module.exports = {
    name: 'voiceStateUpdate',
    async execute(oldState, newState) {
        if (!oldState.channel) return;
        if (oldState.channelId === newState.channelId) return;

        const client = oldState.client;
        const subscription = client.subscriptions.get(oldState.guild.id);
        
        if (!subscription) return;

        const members = oldState.channel.members.filter(m => !m.user.bot);
        if (members.size === 0) {
            logger.info('No listeners remaining, leaving channel', { guild: oldState.guild.id, channel: oldState.channel.name });
            
            const embed = new EmbedBuilder()
                .setTitle(`${client.emotes.success} | No one listening, leaving the channel!`)
                .setDescription('Thank you for using The Pack music bot.')
                .setFooter({ text: 'The Pack', iconURL: client.logo })
                .setColor('#ff006a');

            try {
                const textChannel = oldState.guild.channels.cache.find(c => c.type === 0 && c.permissionsFor(client.user).has('SendMessages'));
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
