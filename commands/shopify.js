const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../logger');
const fetch = require('node-fetch');

module.exports = {
	isEphemeral: true,
	data: new SlashCommandBuilder()
		.setName('shopify')
		.setDescription('Provides info on a Shopify product such as stock numbers and add‑to‑cart links.')
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
		let url;

		// 1) Validate URL
		try {
			url = new URL(link);
		} catch {
			const embed = new EmbedBuilder()
				.setDescription(`${interaction.client.emotes.error} | That is not a valid URL!`)
				.setColor('#ff0000')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
			return interaction.editReply({ embeds: [embed] });
		}

		// 2) Ensure it looks like a Shopify product path
		if (!url.pathname.includes('/products/')) {
			const embed = new EmbedBuilder()
				.setDescription(`${interaction.client.emotes.error} | Please provide a valid Shopify product URL (must contain \`/products/\`).`)
				.setColor('#ff0000')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
			return interaction.editReply({ embeds: [embed] });
		}

		// 3) Fetch the .json endpoint
		let json;
		try {
			const res = await fetch(`${url.origin}${url.pathname}.json`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			json = await res.json();
		} catch (e) {
			logger.error('Shopify fetch error: ' + (e.stack || e));
			const embed = new EmbedBuilder()
				.setDescription(`${interaction.client.emotes.error} | Couldn't fetch product data. Is that a Shopify product link?`)
				.setColor('#ff0000')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
			return interaction.editReply({ embeds: [embed] });
		}

		const product = json.product;
		if (!product || !Array.isArray(product.variants)) {
			const embed = new EmbedBuilder()
				.setDescription(`${interaction.client.emotes.error} | No product data found at that URL.`)
				.setColor('#ff0000')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
			return interaction.editReply({ embeds: [embed] });
		}

		// 4) Build variant fields
		const fields = product.variants.map(variant => {
			// build a friendly name
			const opts = [variant.option1, variant.option2, variant.option3]
				.filter(o => o && o !== 'Default Title' && o !== '-');
			const name = opts.join(' ') || `Stock: ${variant.inventory_quantity ?? 'N/A'}`;

			// add‑to‑cart link
			const atc = `${url.origin}/cart/${variant.id}:1`;
			const stock = variant.inventory_quantity;
			return {
				name,
				value: `[Add to Cart](${atc}) – Stock: ${stock != null ? stock : 'N/A'}`,
				inline: true
			};
		});

		// 5) Send embed
		const embed = new EmbedBuilder()
			.setAuthor({ name: product.title })
			.setTitle(url.hostname)
			.setURL(link)
			.setColor('#ff006a')
			.addFields(fields)
			.setFooter({ text: 'Developed by @OlliePCK', iconURL: 'https://i.imgur.com/c3z97p3.png' });

		return interaction.editReply({ embeds: [embed] });
	},
};
