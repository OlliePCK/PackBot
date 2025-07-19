const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('swap')
		.setDescription('Swap the positions of two songs in the queue.')
		.addIntegerOption(opt =>
			opt
				.setName('song_position_1')
				.setDescription('The position of the first song to swap (1 = now playing).')
				.setRequired(true)
		)
		.addIntegerOption(opt =>
			opt
				.setName('song_position_2')
				.setDescription('The position of the second song to swap.')
				.setRequired(true)
		),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
			});
		}

		const pos1 = interaction.options.getInteger('song_position_1');
		const pos2 = interaction.options.getInteger('song_position_2');
		const len = queue.songs.length;

		// Validate positions
		if (
			pos1 < 1 || pos1 > len ||
			pos2 < 1 || pos2 > len
		) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | Please enter valid song positions between 1 and ${len}!`
			});
		}
		if (pos1 === pos2) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | Both positions are the same—nothing to swap.`
			});
		}

		try {
			// If swapping the current track, we need to requeue via skip
			if (pos1 === 1 || pos2 === 1) {
				const other = pos1 === 1 ? pos2 : pos1;
				// Remove the chosen song
				const moved = queue.songs.splice(other - 1, 1)[0];
				// Keep current song
				const current = queue.songs[0];
				// Insert moved song into position 2, and current into position other
				queue.songs.splice(1, 0, moved);
				queue.songs.splice(other, 0, current);
				await queue.skip();
			} else {
				// Simple array swap for non-current tracks
				const idx1 = pos1 - 1;
				const idx2 = pos2 - 1;
				[queue.songs[idx1], queue.songs[idx2]] = [queue.songs[idx2], queue.songs[idx1]];
			}

			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Swapped songs!`)
				.setDescription(`Positions **${pos1}** and **${pos2}** have been swapped.`)
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		} catch (e) {
			console.error('Swap command error:', e);
			const errEmbed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | Couldn’t swap songs`)
				.setDescription('Something went wrong—please try again.')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [errEmbed] });
		}
	},
};
