const discord = require('discord.js');
const guild = require('../models/guildSchema');
const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('settings')
		.setDescription('Change the bots settings. (administator)')
		.addSubcommand(subcommand =>
			subcommand
				.setName('set-live-role')
				.setDescription('Sets the role to be assigned to users who go live.')
				.addRoleOption(option =>
					option
						.setName('live-role')
						.setDescription('The role to be assigned.')
						.setRequired(true),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName('set-live-channel')
				.setDescription('Sets the server live channel for notifications.')
				.addChannelOption(option =>
					option
						.setName('live-channel')
						.setDescription('The servers live channel')
						.setRequired(true),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName('set-general-channel')
				.setDescription('Sets the server general channel.')
				.addChannelOption(option =>
					option
						.setName('general-channel')
						.setDescription('The servers general channel')
						.setRequired(true),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName('info')
				.setDescription('Change the bots settings. (administator)'),
		),
	async execute(interaction) {
		if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
			return interaction.editReply('You aren\'t an admin!');
		}
		const guildProfile = await guild.findOne({ guildId: interaction.guildId });
		if (interaction.options.getSubcommand() === 'set-live-role') {
			const role = interaction.options.getRole('live-role');
			await guild.findOneAndUpdate({ guildId: interaction.guildId }, { liveRoleID: role.id });
			const embed = new discord.EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Set live role!`)
				.addFields([
					{ name: 'Role', value: `${role}` },
					{ name: 'Set by', value: `${interaction.user}` }
				])
				.setFooter({
					text: 'The Pack',
					iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
				})
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });
		}
		else if (interaction.options.getSubcommand() === 'set-live-channel') {
			const channel = interaction.options.getChannel('live-channel');
			if (!channel.isTextBased()) {
				return interaction.editReply('That is not a text channel!');
			}
			await guild.findOneAndUpdate({ guildId: interaction.guildId }, { liveChannelID: channel.id });
			const embed = new discord.EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Set live channel!`)
				.addFields([
					{ name: 'Channel', value: `${channel}` },
					{ name: 'Set by', value: `${interaction.user}` }
				])
				.setFooter({
					text: 'The Pack',
					iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
				})
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });
		}
		else if (interaction.options.getSubcommand() === 'set-general-channel') {
			const channel = interaction.options.getChannel('general-channel');
			if (!channel.isTextBased()) {
				return interaction.editReply('That is not a text channel!');
			}
			await guild.findOneAndUpdate({ guildId: interaction.guildId }, { generalChannelID: channel.id });
			const embed = new discord.EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | Set general channel!`)
				.addFields([
					{ name: 'Channel', value: `${channel}` },
					{ name: 'Set by', value: `${interaction.user}` }
				])
				.setFooter({
					text: 'The Pack',
					iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
				})
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });
		}
		else if (interaction.options.getSubcommand() === 'info') {
			const Guild = await interaction.guild.fetch();
			const embed = new discord.EmbedBuilder()
				.setTitle(`${interaction.guild.name}'s Settings`)
				.setDescription('Please configure the bot using the subcommands if there are no fields below!\n\n**/settings set-live-role `{live-role}`** sets the role assigned to users when they go live **ENSURE THE ROLE IS HIGHER THAN ALL USERS IN ROLE SETTINGS OR THE FEATURE WILL NOT WORK CORRECTLY**\n\n**/settings set-live-channel `{live-channel}`** sets the channel for live notifications to be sent to, setting this enables the live notification feature.\n\n**/settings set-general-channel `{general-channel}`** sets the general channel for play time notifications to be sent to, setting this enables the game expose feature.\n\nTo get the ID\'s of roles/channels, **enable developer mode** in Discord settings, right click the role/channel and select `Copy ID`\n ')
				.setFooter({
					text: 'The Pack',
					iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
				})
				.setColor('#ff006a');
			let embObj = [
				{ name: 'Live Role', value: '' },
				{ name: 'Live Channel', value: '' },
				{ name: 'General Channel', value: '' },
			]
			if (guildProfile.liveRoleID) {
				await Guild.roles.fetch(guildProfile.liveRoleID)
					.then(role => embObj[0].value = `${role}`)
					.catch(console.error);
			}
			else { embObj[0].value = '`Not Set`'; }
			if (guildProfile.liveChannelID) embObj[1].value = `<#${guildProfile.liveChannelID}>`;
			else embObj[1].value = '`Not Set`';
			if (guildProfile.generalChannelID) embObj[2].value = `<#${guildProfile.generalChannelID}>`;
			else embObj[2].value = '`Not Set`';
			embed.addFields(embObj);
			return interaction.editReply({ embeds: [embed] });
		}
	},
};