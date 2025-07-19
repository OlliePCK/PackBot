const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database/db.js');

const SETTERS = {
	'set-live-role': {
		option: 'live-role',
		column: 'liveRoleID',
		type: 'role',
		title: 'Set live role!',
		validate: () => true,
		format: role => `${role}`,
		fieldName: 'Role'
	},
	'set-live-channel': {
		option: 'live-channel',
		column: 'liveChannelID',
		type: 'channel',
		title: 'Set live channel!',
		validate: ch => ch.isTextBased(),
		error: '🚫 That is not a text channel!',
		format: ch => `<#${ch.id}>`,
		fieldName: 'Channel'
	},
	'set-general-channel': {
		option: 'general-channel',
		column: 'generalChannelID',
		type: 'channel',
		title: 'Set general channel!',
		validate: ch => ch.isTextBased(),
		error: '🚫 That is not a text channel!',
		format: ch => `<#${ch.id}>`,
		fieldName: 'Channel'
	},
	'set-youtube-channel': {
		option: 'youtube-channel',
		column: 'youtubeChannelID',
		type: 'channel',
		title: 'Set YouTube channel!',
		validate: ch => ch.isTextBased(),
		error: '🚫 That is not a text channel!',
		format: ch => `<#${ch.id}>`,
		fieldName: 'Channel'
	}
};

module.exports = {
	isEphemeral: true,
	data: new SlashCommandBuilder()
		.setName('settings')
		.setDescription('Change the bot’s settings (admin only)')
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.addSubcommand(sc =>
			sc
				.setName('set-live-role')
				.setDescription('Assign role when users go live')
				.addRoleOption(o => o.setName('live-role').setDescription('Role to assign').setRequired(true))
		)
		.addSubcommand(sc =>
			sc
				.setName('set-live-channel')
				.setDescription('Channel for live notifications')
				.addChannelOption(o => o.setName('live-channel').setDescription('Text channel').setRequired(true))
		)
		.addSubcommand(sc =>
			sc
				.setName('set-general-channel')
				.setDescription('Channel for general notifications')
				.addChannelOption(o => o.setName('general-channel').setDescription('Text channel').setRequired(true))
		)
		.addSubcommand(sc =>
			sc
				.setName('set-youtube-channel')
				.setDescription('Channel for YouTube notifications')
				.addChannelOption(o => o.setName('youtube-channel').setDescription('Text channel').setRequired(true))
		)
		.addSubcommand(sc =>
			sc
				.setName('info')
				.setDescription('View current settings')
		),

	/**
	 * @param {import('discord.js').CommandInteraction} interaction
	 * @param {object} guildProfile
	 */
	async execute(interaction, guildProfile) {
		const sub = interaction.options.getSubcommand();

		// ---- 1) /settings info ----
		if (sub === 'info') {
			const fields = [
				{ name: 'Live Role', value: guildProfile.liveRoleID ? `<@&${guildProfile.liveRoleID}>` : '`Not set`', inline: true },
				{ name: 'Live Channel', value: guildProfile.liveChannelID ? `<#${guildProfile.liveChannelID}>` : '`Not set`', inline: true },
				{ name: 'General Chan', value: guildProfile.generalChannelID ? `<#${guildProfile.generalChannelID}>` : '`Not set`', inline: true },
				{ name: 'YouTube Chan', value: guildProfile.youtubeChannelID ? `<#${guildProfile.youtubeChannelID}>` : '`Not set`', inline: true },
			];
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.guild.name} Settings`)
				.setDescription('Use `/settings set-<thing>` to update these.')
				.addFields(fields)
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');
			return interaction.editReply({ embeds: [embed] });
		}

		// ---- 2) One of the setter subcommands ----
		const cfg = SETTERS[sub];
		// pull the raw option (Role or Channel)
		const target = cfg.type === 'role'
			? interaction.options.getRole(cfg.option)
			: interaction.options.getChannel(cfg.option);

		// validation
		if (!cfg.validate(target)) {
			return interaction.editReply({ content: cfg.error });
		}

		// perform the DB update
		await db.pool.query(
			`UPDATE Guilds SET ${cfg.column} = ? WHERE guildId = ?`,
			[target.id, interaction.guildId]
		);

		// sync your cache object in memory
		guildProfile[cfg.column] = target.id;

		// build a success embed
		const embed = new EmbedBuilder()
			.setTitle(`${interaction.client.emotes.success} | ${cfg.title}`)
			.addFields(
				{ name: cfg.fieldName, value: cfg.format(target), inline: true },
				{ name: 'Set by', value: `${interaction.user}`, inline: true }
			)
			.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
			.setColor('#ff006a');

		return interaction.editReply({ embeds: [embed] });
	},
};
