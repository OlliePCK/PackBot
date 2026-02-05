const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');
const { fetchShopifyProduct } = require('../utils/shopify');

module.exports = {
	isEphemeral: true,
	data: new SlashCommandBuilder()
		.setName('shopify')
		.setDescription('Provides info on a Shopify product such as stock numbers and add-to-cart links.')
		.addStringOption(opt =>
			opt
				.setName('link')
				.setDescription('A link to a Shopify product')
				.setRequired(true)
		),

	/**
	 * @param {import('discord.js').CommandInteraction} interaction
	 * @param {object} guildProfile
	 */
	async execute(interaction, guildProfile) {
		const link = interaction.options.getString('link');
		let shopify;

		try {
			shopify = await fetchShopifyProduct(link);
		} catch (error) {
			logger.error('Shopify command error', { error: error.message });
			const embed = new EmbedBuilder()
				.setDescription(`${interaction.client.emotes.error} | ${error.message}`)
				.setColor('#ff0000')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
			return interaction.editReply({ embeds: [embed] });
		}

		const fields = shopify.variants.map(variant => ({
			name: variant.title || `Stock: ${variant.stock ?? 'N/A'}`,
			value: `[Add to Cart](${variant.addToCart})\nStock: ${variant.stock != null ? variant.stock : 'N/A'}`,
			inline: true
		}));

		const embed = new EmbedBuilder()
			.setAuthor({ name: shopify.title })
			.setTitle(shopify.url.hostname)
			.setURL(link)
			.setColor('#ff006a')
			.addFields(fields)
			.setFooter({ text: 'Developed by @OlliePCK', iconURL: 'https://i.imgur.com/c3z97p3.png' });

		return interaction.editReply({ embeds: [embed] });
	},
};
