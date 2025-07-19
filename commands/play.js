const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const ALLOWED_HOSTNAMES = new Set([
	'youtube.com',
	'www.youtube.com',
	'youtu.be',
	'open.spotify.com',
	'spotify.com',
	'soundcloud.com',
	'www.soundcloud.com',
	'discord.com',
	'cdn.discordapp.com',
]);

function isAllowedLink(link) {
	try {
		const url = new URL(link);
		return ALLOWED_HOSTNAMES.has(url.hostname.toLowerCase());
	} catch {
		return false; // not a valid URL at all
	}
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('play')
		.setDescription('Play a song from YouTube, Soundcloud or Spotify')
		.addStringOption(opt => opt
			.setName('song')
			.setDescription('Playlist URL, song URL, or search terms')
			.setRequired(false)
		),
	async execute(interaction, guildProfile) {
		const voiceChannel = interaction.member.voice.channel;
		if (!voiceChannel) {
			return interaction.editReply('🚫 You need to be in a voice channel first!');
		}

		let query = interaction.options.getString('song');
		const queue = interaction.client.distube.getQueue(interaction);

		// No argument: either resume or error
		if (!query) {
			if (!queue) {
				return interaction.editReply('❌ There’s nothing in queue right now.');
			}
			if (queue.paused) {
				queue.resume();
				return interaction.editReply('▶️ Resumed playback!');
			}
			return interaction.editReply('⚠️ You must specify what to play or resume a paused song.');
		}

		// If it looks like a URL, enforce allowlist
		const isUrl = /^https?:\/\//i.test(query);
		if (isUrl && !isAllowedLink(query)) {
			const errEmbed = new EmbedBuilder()
				.setTitle('🚫 Invalid link')
				.setDescription('I only support YouTube, Spotify, SoundCloud or Discord URLs.')
				.setColor('#ff006a')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
			return interaction.editReply({ embeds: [errEmbed] });
		}

		// Play (URL or search term)
		try {
			await interaction.client.distube.play(
				voiceChannel,
				query,
				{ member: interaction.member, textChannel: interaction.channel }
			);
			return interaction.editReply('✅ Added to queue!');
		} catch (e) {
			console.error(e);
			const errEmbed = new EmbedBuilder()
				.setTitle('❌ Could not play that')
				.setDescription('Something went wrong—please try again.')
				.setColor('#ff006a')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
			return interaction.editReply({ embeds: [errEmbed] });
		}
	},
};
