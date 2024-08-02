/* eslint-disable no-undef */
/* eslint-disable no-inline-comments */
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('shopify')
		.setDescription('Provides info on a Shopify product such as stock numbers and add to cart links.')
		.addStringOption(option => option.setName('link').setDescription('A link to a Shopify product').setRequired(true)),
	execute: async (interaction) => {
		const fetch = require('node-fetch');
		const validURL = (str) => {
			const pattern = new RegExp(
				'^(https?:\\/\\/)?' + // protocol
                    '((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|' + // domain name
                    '((\\d{1,3}\\.){3}\\d{1,3}))' + // OR ip (v4) address
                    '(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*' + // port and path
                    '(\\?[;&a-z\\d%_.~+=-]*)?' + // query string
                    '(\\#[-a-z\\d_]*)?$',
				'i',
			); // fragment locator
			return !!pattern.test(str);
		};
		const sendVariants = (json, atcBase) => {
			if (json.product) {
				const { product } = json;
				const { title: name, variants } = product;
				const fieldList = [];
				for (const variant of variants) {
					const variantNames = [];
					for (let i = 1; i < 4; i++) {
						const key = `option${i}`;
						if (
							variant[key] &&
                            variant[key] != 'Default Title' &&
                            variant[key] != '-'
						) {
							variantNames.push(variant[key]);
						}
					}
					const variant_id = variant.id.toString();
					const variant_name = variantNames.join(' ').trim();
					const variant_stock = variant.inventory_quantity;
					const atc =
                        atcBase.protocol +
                        '//' +
                        atcBase.hostname +
                        '/cart/' +
                        variant_id +
                        ':1';
					if (variant_name == '') {
						const entry = {
							name: '**Stock #: ' + variant_stock + '**',
							value: '[Add to Cart](' + atc + ')',
							inline: true,
						};
						fieldList.push(entry);
					}
					else if (variant_stock == undefined) {
						const entry = {
							name: '**' + variant_name + '**',
							value: '[Stock #: N/A](' + atc + ')',
							inline: true,
						};
						fieldList.push(entry);
					}
					else {
						const entry = {
							name: '**' + variant_name + '**',
							value: '[Stock #: ' + variant_stock + '](' + atc + ')',
							inline: true,
						};
						fieldList.push(entry);
					}
				}
				const VariantsEmbed = {
					author: {
						name: name,
					},
					title: atcBase.hostname.toString(),
					url: interaction.options.getString('link'),
					color: 0xff006a,
					fields: fieldList,
					footer: {
						text: 'Developed by @OlliePCK',
						icon_url: 'https://i.imgur.com/c3z97p3.png',
					},
				};
				return interaction.editReply({ embeds: [VariantsEmbed] });
			}
			else {
				return interaction.editReply('That is not a Shopify link!');
			}
		}
		if (!validURL(interaction.options.getString('link'))) {
			return interaction.editReply('That is not a Shopify link!');
		}
		else if (validURL(interaction.options.getString('link'))) {
			const atcBase = new URL(interaction.options.getString('link'));
			const base_url = interaction.options.getString('link');
			const url = base_url + '.json';
			const settings = { method: 'Get' };
			fetch(url, settings)
				.then((res) => {
					if (res.ok) {
						return res.text();
					}
					else {
						return;
					}
				})
				.then(resAsBodyText => {
					try {
						const bodyAsJson = JSON.parse(resAsBodyText);
						if (typeof bodyAsJson == 'object') {
							return sendVariants(bodyAsJson, atcBase);
						}
						else {
							return interaction.editReply('That is not a valid Shopify link!');
						}
					}
					catch (error) {
						return interaction.editReply('That is not a valid Shopify link!');
					}
				})
				.catch(() => {
					return interaction.editReply('That is not a valid Shopify link!');
				});
		}
	},
};