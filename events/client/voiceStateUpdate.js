const { isVoiceChannelEmpty } = require("distube");
const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'voiceStateUpdate',
    execute(oldState, newState) {
        if (!oldState?.channel) return;
        const voice = oldState.client.distube.voices.get(oldState);
        if (voice && isVoiceChannelEmpty(oldState)) {
            voice.leave();
        }
    }
}


