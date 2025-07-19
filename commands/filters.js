const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { defaultFilters } = require('distube');

const FILTER_CHOICES = [
	...Object.keys(defaultFilters).map(name => ({ name, value: name })),
	{ name: 'Off', value: 'off' },
];

module.exports = {
	data: new SlashCommandBuilder()
		.setName('filters')
		.setDescription('Apply/turn off filters for the music.')
		.addStringOption(option =>
			option
				.setName('filter')
				.setDescription('The filter to toggle')
				.setRequired(true)
				.addChoices(...FILTER_CHOICES)
		),

	async execute(interaction, guildProfile) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) {
			return interaction.editReply({
				content: `${interaction.client.emotes.error} | There is nothing in the queue right now!`
			});
		}

		const choice = interaction.options.getString('filter');
		if (choice === 'off') {
			queue.filters.clear();
		} else {
			if (!defaultFilters[choice]) {
				return interaction.editReply({
					content: `${interaction.client.emotes.error} | Not a valid filter.`
				});
			}

			if (queue.filters.has(choice)) {
				queue.filters.remove(choice);
			} else {
				queue.filters.add(choice);
			}
		}

		const embed = new EmbedBuilder()
			.setTitle(`${interaction.client.emotes.success} | Filters updated!`)
			.addFields(
				{ name: 'Active filters', value: `\`${queue.filters.names.join(', ') || 'Off'}\``, inline: true },
				{ name: 'Requested by', value: `${interaction.user}`, inline: true },
			)
			.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
			.setColor('#ff006a');

		return interaction.editReply({ embeds: [embed] });
	},
};
