/* eslint-disable no-undef */
/* eslint-disable no-inline-comments */
const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('shopify')
		.setDescription('Provides info on a Shopify product such as stock numbers and add to cart links.')
		.addStringOption(option => option.setName('link').setDescription('A link to a Shopify product').setRequired(true)),
	async execute(interaction) {
		const fetch = require('node-fetch');
		function validURL(str) {
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
		}
		function sendVariants(json, atcBase) {
			if (json.product) {
				const product = json.product;
				const name = product.title;
				const field_list = [];
				for (variant in product.variants) {
					const variant_names = [];
					variant = product.variants[variant];
					for (i = 1; i < 4; i++) {
						const k = `option${i}`;
						if (
							variant[k] &&
                            variant[k] != 'Default Title' &&
                            variant[k] != '-'
						) {
							variant_names.push(variant[k]);
						}
					}
					const variant_id = variant.id.toString();
					const variant_name = variant_names.join(' ').trim();
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
						field_list.push(entry);
					}
					else if (variant_stock == undefined) {
						const entry = {
							name: '**' + variant_name + '**',
							value: '[Stock #: N/A](' + atc + ')',
							inline: true,
						};
						field_list.push(entry);
					}
					else {
						const entry = {
							name: '**' + variant_name + '**',
							value: '[Stock #: ' + variant_stock + '](' + atc + ')',
							inline: true,
						};
						field_list.push(entry);
					}
				}
				const VariantsEmbed = {
					author: {
						name: name,
					},
					title: atcBase.hostname.toString(),
					url: interaction.options.getString('link'),
					color: 0xff006a,
					fields: field_list,
					footer: {
						text: 'Developed by Ollie#4747',
						icon_url: 'https://i.imgur.com/c3z97p3.png',
					},
				};
				return interaction.reply({ embeds: [VariantsEmbed] });
			}
			else {
				return interaction.reply('That is not a Shopify link!');
			}
		}
		if (!validURL(interaction.options.getString('link'))) {
			return interaction.reply('That is not a Shopify link!');
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
							return interaction.reply('That is not a valid Shopify link!');
						}
					}
					catch (error) {
						return interaction.reply('That is not a valid Shopify link!');
					}
				})
				.catch(() => {
					return interaction.reply('That is not a valid Shopify link!');
				});
		}
	},
};