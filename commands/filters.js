const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { defaultFilters } = require('distube');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('filters')
		.setDescription('Apply/turn off filters for the music.')
		.addStringOption(option =>
			option
			  .setName("filter")
			  .setDescription("The filter to set")
			  .setRequired(true)
			  .addChoices(...Object.keys(defaultFilters).map(k => ({ name: k, value: k })), { name: 'off', value: 'off' }),
		  ),
	async execute(interaction) {
		const queue = interaction.client.distube.getQueue(interaction);
		if (!queue) return interaction.editReply(`${interaction.client.emotes.error} | There is nothing in the queue right now!`);
		if (interaction.options.getString('filter') === 'off' && queue.filters.size) queue.filters.clear();
		else if (Object.keys(interaction.client.distube.filters).includes(interaction.options.getString('filter'))) {
			if(queue.filters.has(interaction.options.getString('filter'))) queue.filters.remove(interaction.options.getString('filter'));
			else queue.filters.add(interaction.options.getString('filter'));
		}
		else if (interaction.options.getString('filter')) return interaction.editReply(`${interaction.client.emotes.error} | Not a valid filter`);
		const embed = new EmbedBuilder()
			.setTitle(`${interaction.client.emotes.success} | Filter set!`)
			.addFields(
				{ name: 'Filter:', value: `\`${queue.filters.names.join(', ') || 'Off'}\``, inline: true },
				{ name: 'Requested by', value: `${interaction.user}`, inline: true },
			)
			.setFooter({
				text: 'The Pack',
				iconURL: interaction.client.logo
			})
			.setColor('#ff006a');
		return interaction.editReply({ embeds: [embed] });
	},
};