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
			await interaction.reply({ content: 'You are not in a voice channel!' });
			await interaction.deleteReply();
		}
		try {
			interaction.client.distube.play(voiceChannel, song, { member: interaction.member, textChannel: interaction.channel });
			await interaction.reply({ content: 'Song has been added!' });
			await interaction.deleteReply();
		}
		catch (e) {
			console.log(e);
			await interaction.reply(`${interaction.client.emotes.error} | Error: \`${e}\``);
			await interaction.deleteReply();
		}
	},
};