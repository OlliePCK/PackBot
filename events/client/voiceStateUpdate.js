const { isVoiceChannelEmpty } = require('distube');
const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'voiceStateUpdate',
    async execute(oldState, newState) {
        // 1) Ignore joins & moves unless it was from a real channel
        if (!oldState.channel) return;
        // 2) Ignore events where the user stays in the same channel
        if (oldState.channelId === newState.channelId) return;

        const client = oldState.client;
        const distube = client.distube;

        // 3) Do we have an active Distube voice connection here?
        const voice = distube.voices.get(oldState);
        if (!voice) return;

        // 4) If the channel is now empty of non‑bot members, say goodbye
        if (isVoiceChannelEmpty(oldState)) {
            const embed = new EmbedBuilder()
                .setTitle(`${client.emotes.success} | No one listening, leaving the channel!`)
                .setDescription('Thank you for using The Pack music bot.')
                .setFooter({ text: 'The Pack', iconURL: client.logo })
                .setColor('#ff006a');

            // Try to notify in the text channel, if there’s a queue
            try {
                const queue = distube.getQueue(oldState);
                if (queue?.textChannel) {
                    await queue.textChannel.send({ embeds: [embed] });
                }
            } catch (err) {
                console.error('Failed to send leave message:', err);
            }

            // Finally, leave the voice channel
            try {
                await distube.voices.leave(oldState);
            } catch (err) {
                console.error('Failed to leave voice channel:', err);
            }
        }
    },
};
