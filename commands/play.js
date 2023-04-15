const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('play')
		.setDescription('Play a song from YouTube, Soundcloud or Spotify')
		.addStringOption(option => option.setName('song').setDescription('Takes a playlist, search terms or song link.')),
	async execute(interaction) {
		const voiceChannel = interaction.member.voice.channel;
		if (!voiceChannel) {
			await interaction.editReply({ content: 'You are not in a voice channel!' });
			await interaction.deleteReply();
			return;
		}
		const queue = interaction.client.distube.getQueue(interaction);
		let song = interaction.options.getString('song');
		if (!song) {
			if (!queue) {
				await interaction.editReply({ content: 'There is nothing in the queue right now!' });
				await interaction.deleteReply();
				return;
			}
			if (queue.paused) {
				try {
					queue.resume();
				}
				catch (e) {
					console.log(e);
					const embed = new EmbedBuilder()
						.setTitle(`${interaction.client.emotes.error} | An error occurred!`)
						.setDescription('Please try again.')
						.setFooter({
							text: 'The Pack',
							iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
						})
						.setColor('#ff006a');
					return interaction.editReply({ embeds: [embed] });
				}
				const embed = new EmbedBuilder()
					.setTitle(`${interaction.client.emotes.success} | The song has been resumed!`)
					.addFields(
						{ name: 'Requested by', value: `${interaction.user}`, inline: true },
					)
					.setFooter({
						text: 'The Pack',
						iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
					})
					.setColor('#ff006a');
				return interaction.editReply({ embeds: [embed] });
			}
			else {
				await interaction.editReply({ content: 'You need to provide a song to play!' });
				await interaction.deleteReply();
				return;
			}
		}
		try {
			if (song.startsWith("https://") || song.startsWith("http://")) {
				interaction.client.distube.play(voiceChannel, song, { member: interaction.member, textChannel: interaction.channel });
				await interaction.editReply({ content: 'Song has been added!' });
				await interaction.deleteReply();
			}
			else {
				song = song + ' audio';
				interaction.client.distube.play(voiceChannel, song, { member: interaction.member, textChannel: interaction.channel });
				await interaction.editReply({ content: 'Song has been added!' });
				await interaction.deleteReply();
			}
		}
		catch (e) {
			console.log(e);
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | An error occurred!`)
				.setDescription('Please try again.')
				.setFooter({
					text: 'The Pack',
					iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
				})
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });
		}
	},
};
