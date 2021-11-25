const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('play')
		.setDescription('Play a song from YouTube, Soundcloud or Spotify')
		.addStringOption(option => option.setName('song').setDescription('Takes a playlist, search terms or song link.').setRequired(true)),
	async execute(interaction) {
		const voiceChannel = interaction.member.voice.channel;
		const song = interaction.options.getString('song');
		if (!voiceChannel) {
			await interaction.editReply({ content: 'You are not in a voice channel!' });
			await interaction.deleteReply();
		}
		try {
			interaction.client.distube.playVoiceChannel(voiceChannel, song, { member: interaction.member, textChannel: interaction.channel });
			await interaction.editReply({ content: 'Song has been added!' });
			await interaction.deleteReply();
		}
		catch (e) {
			console.log(e);
			await interaction.editReply(`${interaction.client.emotes.error} | Error: \`${e}\``);
			await interaction.deleteReply();
		}
	},
};