const { isVoiceChannelEmpty } = require("distube");
const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'voiceStateUpdate',
    execute(oldState, newState) {
        if (!oldState?.channel) return;
        const voice = oldState.client.distube.voices.get(oldState);
        if (voice && isVoiceChannelEmpty(oldState)) {
            const embed = new EmbedBuilder()
                .setTitle(`${oldState.client.emotes.success} | No one listening, leaving the channel!`)
                .setDescription('Thank you for using The Pack music bot.')
                .setFooter({
                    text: 'The Pack',
                    iconURL: oldState.client.logo
                })
                .setColor('#ff006a');
            // Get the text channel from the queue
            const queue = oldState.client.distube.getQueue(oldState.guild.id);
            if (queue && queue.textChannel) {
                queue.textChannel.send({ embeds: [embed] }).catch(console.error);
            }
            voice.leave();
        }
    }
}