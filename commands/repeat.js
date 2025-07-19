const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('repeat')
		.setDescription('Set the repeat mode of the currently playing music.')
		.addStringOption(opt =>
			opt
				.setName('mode')
				.setDescription('Repeat modes')
				.setRequired(true)
				.addChoices(
					{ name: 'Queue repeat', value: 'queue' },
					{ name: 'Song repeat', value: 'song' },
					{ name: 'Repeat off', value: 'off' }
				)
		),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
			});
		}

		try {
			// map choice to DisTube mode number
			const modeMap = { off: 0, song: 1, queue: 2 };
			const choice = interaction.options.getString('mode');
			const newMode = queue.setRepeatMode(modeMap[choice]);

			// human‑friendly text
			const modeText = newMode === 0
				? 'Off'
				: newMode === 1
					? 'Repeat song'
					: 'Repeat queue';

			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Set repeat mode: \`${modeText}\``)
				.addFields({ name: 'Requested by', value: `${interaction.user}`, inline: true })
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		} catch (e) {
			console.error('Repeat command error:', e);
			const errEmbed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | Couldn’t set repeat mode`)
				.setDescription('Something went wrong—please try again.')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [errEmbed] });
		}
	},
};
