const { SlashCommandBuilder } = require('@discordjs/builders');
const discord = require('discord.js');
const guild = require('../models/guildSchema');

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
		const guildProfile = await guild.findOne({ guildId: interaction.guildId });
		if (interaction.options.getSubcommand() === 'set-live-role') {
			const role = interaction.options.getRole('live-role');
			await guild.findOneAndUpdate({ guildId: interaction.guildId }, { liveRoleID: role.id });
			const embed = new discord.MessageEmbed()
				.setTitle(`${interaction.client.emotes.success} | Set live role!`)
				.addField('Role', `${role}`, true)
				.addField('Set by', `${interaction.user}`, true)
				.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
				.setColor('#ff006a');
			interaction.editReply({ embeds: [embed] });
		}
		else if (interaction.options.getSubcommand() === 'set-live-channel') {
			const channel = interaction.options.getChannel('live-channel');
			if (!channel.isText()) {
				return interaction.editReply('That is not a text channel!');
			}
			await guild.findOneAndUpdate({ guildId: interaction.guildId }, { liveChannelID: channel.id });
			const embed = new discord.MessageEmbed()
				.setTitle(`${interaction.client.emotes.success} | Set live channel!`)
				.addField('Channel', `${channel}`, true)
				.addField('Set by', `${interaction.user}`, true)
				.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
				.setColor('#ff006a');
			interaction.editReply({ embeds: [embed] });
		}
		else if (interaction.options.getSubcommand() === 'set-general-channel') {
			const channel = interaction.options.getChannel('general-channel');
			if (!channel.isText()) {
				return interaction.editReply('That is not a text channel!');
			}
			await guild.findOneAndUpdate({ guildId: interaction.guildId }, { generalChannelID: channel.id });
			const embed = new discord.MessageEmbed()
				.setTitle(`${interaction.client.emotes.success} | Set general channel!`)
				.addField('Channel', `${channel}`, true)
				.addField('Set by', `${interaction.user}`, true)
				.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
				.setColor('#ff006a');
			interaction.editReply({ embeds: [embed] });
		}
		else if (interaction.options.getSubcommand() === 'info') {
			const Guild = await interaction.guild.fetch();
			const embed = new discord.MessageEmbed()
				.setTitle(`${interaction.guild.name}'s Settings`)
				.setDescription('Please configure the bot using the subcommands if there are no fields below!\n\n**/settings set-live-role `{live-role}`** sets the role assigned to users when they go live **ENSURE THE ROLE IS HIGHER THAN ALL USERS IN ROLE SETTINGS OR THE FEATURE WILL NOT WORK CORRECTLY**\n\n**/settings set-live-channel `{live-channel}`** sets the channel for live notifications to be sent to, setting this enables the live notification feature.\n\n**/settings set-general-channel `{general-channel}`** sets the general channel for play time notifications to be sent to, setting this enables the game expose feature.\n\nTo get the ID\'s of roles/channels, **enable developer mode** in Discord settings, right click the role/channel and select `Copy ID`\n ')
				.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
				.setColor('#ff006a');
			if (guildProfile.liveRoleID) {
				await Guild.roles.fetch(guildProfile.liveRoleID)
					.then(role => embed.addField('Live Role', `${role}`, true))
					.catch(console.error);
			}
			else { embed.addField('Live Role', '`Not Set`', true); }
			if (guildProfile.liveChannelID) embed.addField('Live Channel', `<#${guildProfile.liveChannelID}>`, true);
			else embed.addField('Live Channel', '`Not Set`', true);
			if (guildProfile.generalChannelID) embed.addField('General Channel', `<#${guildProfile.generalChannelID}>`, true);
			else embed.addField('General Channel', '`Not Set`', true);
			interaction.editReply({ embeds: [embed] });
		}
	},
};