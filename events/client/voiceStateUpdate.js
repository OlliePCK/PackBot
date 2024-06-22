const { isVoiceChannelEmpty } = require("distube");
const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'voiceStateUpdate',
    execute(oldState, newState) {
        if (!oldState?.channel) return;
        const voice = oldState.client.distube.voices.get(oldState);
        const queue = oldState.client.distube.queues.get(oldState);

        if (voice && isVoiceChannelEmpty(oldState)) {
            voice.leave();
            const embed = new EmbedBuilder()
                .setTitle(`${oldState.client.emotes.success} | No one listening, leaving the channel!`)
                .setDescription('Thank you for using The Pack music bot.')
                .setFooter({
                    text: 'The Pack',
                    iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
                })
                .setColor('#ff006a');
            queue.textChannel.send({ embeds: [embed] });
        }
    }
}


