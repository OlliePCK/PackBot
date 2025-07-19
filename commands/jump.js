const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('jump')
		.setDescription('Jump to a song position in the queue.')
		.addIntegerOption(opt =>
			opt
				.setName('position')
				.setDescription('1 = first in queue, 2 = second… -1 = last, -2 = second‑last, etc.')
				.setRequired(true)
		),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
			});
		}

		const pos = interaction.options.getInteger('position');
		const len = queue.songs.length;
		const index = pos > 0
			? pos - 1
			: len + pos;

		if (index < 0 || index >= len) {
			const errEmbed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | Invalid position`)
				.setDescription(`Please specify a number between 1 and ${len}, or -1 and -${len}.`)
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [errEmbed] });
		}

		try {
			const song = await queue.jump(index);
			const successEmbed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Jumped to:`)
				.setDescription(`▶️ Now playing **${song.name}**`)
				.addFields({ name: 'Requested by', value: `${interaction.user}`, inline: true })
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [successEmbed] });
		} catch (e) {
			console.error('Jump error:', e);
			const errEmbed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | Couldn’t jump`)
				.setDescription('Something went wrong—please try a different position.')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [errEmbed] });
		}
	},
};
