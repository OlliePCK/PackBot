const discord = require('discord.js');
const { SlashCommandBuilder, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const db = require('../database/db.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('settings')
		.setDescription('Change the bots settings. (administator)')
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
				.setName('set-youtube-channel')
				.setDescription('Sets the server channel for YouTube notifications.')
				.addChannelOption(option =>
					option
						.setName('youtube-channel')
						.setDescription('The servers channel for YouTube notifications.')
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
		try {
			const [rows] = await db.pool.query('SELECT * FROM Guilds WHERE guildId = ?', [interaction.guildId]);
			const guildProfile = rows[0];
			if (interaction.options.getSubcommand() === 'set-live-role') {
				const role = interaction.options.getRole('live-role');
				await db.pool.query('UPDATE Guilds SET liveRoleID = ? WHERE guildId = ?', [role.id, interaction.guildId]);
				const embed = new discord.EmbedBuilder()
					.setTitle(`${interaction.client.emotes.success} | Set live role!`)
					.addFields([
						{ name: 'Role', value: `${role}` },
						{ name: 'Set by', value: `${interaction.user}` }
					])
					.setFooter({
						text: 'The Pack',
						iconURL: interaction.client.logo
					})
					.setColor('#ff006a');
				return interaction.editReply({ embeds: [embed] });
			}
			else if (interaction.options.getSubcommand() === 'set-live-channel') {
				const channel = interaction.options.getChannel('live-channel');
				if (!channel.isTextBased()) {
					return interaction.editReply('That is not a text channel!');
				}
				await db.pool.query('UPDATE Guilds SET liveChannelID = ? WHERE guildId = ?', [channel.id, interaction.guildId]);
				const embed = new discord.EmbedBuilder()
					.setTitle(`${interaction.client.emotes.success} | Set live channel!`)
					.addFields([
						{ name: 'Channel', value: `${channel}` },
						{ name: 'Set by', value: `${interaction.user}` }
					])
					.setFooter({
						text: 'The Pack',
						iconURL: interaction.client.logo
					})
					.setColor('#ff006a');
				return interaction.editReply({ embeds: [embed] });
			}
			else if (interaction.options.getSubcommand() === 'set-general-channel') {
				const channel = interaction.options.getChannel('general-channel');
				if (!channel.isTextBased()) {
					return interaction.editReply('That is not a text channel!');
				}
				await db.pool.query('UPDATE Guilds SET generalChannelID = ? WHERE guildId = ?', [channel.id, interaction.guildId]);
				const embed = new discord.EmbedBuilder()
					.setTitle(`${interaction.client.emotes.success} | Set general channel!`)
					.addFields([
						{ name: 'Channel', value: `${channel}` },
						{ name: 'Set by', value: `${interaction.user}` }
					])
					.setFooter({
						text: 'The Pack',
						iconURL: interaction.client.logo
					})
					.setColor('#ff006a');
				return interaction.editReply({ embeds: [embed] });
			}
			else if (interaction.options.getSubcommand() === 'set-youtube-channel') {
				const channel = interaction.options.getChannel('youtube-channel');
				if (!channel.isTextBased()) {
					return interaction.editReply('That is not a text channel!');
				}
				await db.pool.query('UPDATE Guilds SET youtubeChannelID = ? WHERE guildId = ?', [channel.id, interaction.guildId]);
				const embed = new discord.EmbedBuilder()
					.setTitle(`${interaction.client.emotes.success} | Set YouTube channel!`)
					.addFields([
						{ name: 'Channel', value: `${channel}` },
						{ name: 'Set by', value: `${interaction.user}` }
					])
					.setFooter({
						text: 'The Pack',
						iconURL: interaction.client.logo
					})
					.setColor('#ff006a');
				return interaction.editReply({ embeds: [embed] });
			}
			else if (interaction.options.getSubcommand() === 'info') {
				const Guild = await interaction.guild.fetch();
				const embed = new discord.EmbedBuilder()
					.setTitle(`${interaction.guild.name}'s Settings`)
					.setDescription('Here are the current settings for the server. To change them use `/settings set-<setting>`. For example `/settings set-live-role`.')
					.setFooter({
						text: 'The Pack',
						iconURL: interaction.client.logo
					})
					.setColor('#ff006a');
				let embObj = [
					{ name: 'Live Role', value: '' },
					{ name: 'Live Channel', value: '' },
					{ name: 'General Channel', value: '' },
					{ name: 'YouTube Channel', value: ''}
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
				if (guildProfile.youtubeChannelID) embObj[3].value = `<#${guildProfile.youtubeChannelID}>`;
				else embObj[3].value = '`Not Set`';
				embed.addFields(embObj);
				return interaction.editReply({ embeds: [embed] });
			}
		} catch (error) {
			console.error(error);
			return interaction.editReply('An error occured while executing this command!');
		}
	},
};