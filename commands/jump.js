const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('jump')
		.setDescription('Jump to the song position in the queue.')
		.addIntegerOption(option =>
			option.setName('position')
				.setDescription('Position, the next one is 1, 2,... The previous one is -1, -2,...')
				.setRequired(true)),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		const pos = Number(interaction.options.getInteger('position'));
		if (isNaN(pos)) return interaction.editReply(`${interaction.client.emotes.error} | Please enter a valid number!`);
		try {
			queue.jump(pos - 1)
				.then(s => {
					const embed = new EmbedBuilder()
						.setTitle(`${interaction.client.emotes.success} | Jumped to: \`${s.name}\``)
						.addFields(
							{ name: 'Requested by', value: `${interaction.user}`, inline: true },
						)
						.setFooter({
							text: 'The Pack',
							iconURL: 'https://i.imgur.com/L49zHx9.jpg'
						})
						.setColor('#ff006a');
					interaction.editReply({ embeds: [embed] });
				}).catch(e => {
					console.log(e);
					const embed = new EmbedBuilder()
						.setTitle(`${interaction.client.emotes.error} | An error occured!`)
						.setDescription('Not a valid place in the queue!')
						.setFooter({
							text: 'The Pack',
							iconURL: 'https://i.imgur.com/L49zHx9.jpg'
						})
						.setColor('#ff006a');
					interaction.editReply({ embeds: [embed] });
				});
		}
		catch (e) {
			console.log(e);
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.error} | An error occured!`)
				.setDescription('Not a valid place in the queue!')
				.setFooter({
					text: 'The Pack',
					iconURL: 'https://i.imgur.com/L49zHx9.jpg'
				})
				.setColor('#ff006a');
			interaction.editReply({ embeds: [embed] });
		}
	},
};