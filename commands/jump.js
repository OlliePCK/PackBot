const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageEmbed } = require('discord.js');

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
				.then(q => {
					const embed = new MessageEmbed()
						.setTitle(`${interaction.client.emotes.success} | Jumped to: \`${q.songs[0].name}\``)
						.addFields(
							{ name: 'Requested by', value: `${interaction.user}`, inline: true },
						)
						.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
						.setColor('#ff006a');
					interaction.editReply({ embeds: [embed] });
				}).catch(e => {
					console.log(e);
					const embed = new MessageEmbed()
						.setTitle(`${interaction.client.emotes.error} | An error occured!`)
						.setDescription('Not a valid place in the queue!')
						.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
						.setColor('#ff006a');
					interaction.editReply({ embeds: [embed] });
				});
		}
		catch (e) {
			console.log(e);
			const embed = new MessageEmbed()
				.setTitle(`${interaction.client.emotes.error} | An error occured!`)
				.setDescription('Not a valid place in the queue!')
				.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
				.setColor('#ff006a');
			interaction.editReply({ embeds: [embed] });
		}
	},
};