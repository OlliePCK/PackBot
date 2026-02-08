const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database/db.js');
const { invalidateGuildCache } = require('../utils/guildSettingsCache');

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
	},
	'toggle-247': {
		column: 'twentyFourSevenMode',
		type: 'toggle',
		title: '24/7 Mode toggled!',
		fieldName: 'Status'
	},
	'set-starboard-channel': {
		option: 'starboard-channel',
		column: 'starboardChannelID',
		type: 'channel',
		title: 'Set starboard channel!',
		validate: ch => ch.isTextBased(),
		error: '🚫 That is not a text channel!',
		format: ch => `<#${ch.id}>`,
		fieldName: 'Channel'
	},
	'set-star-threshold': {
		option: 'threshold',
		column: 'starThreshold',
		type: 'integer',
		title: 'Set star threshold!',
		validate: val => val >= 1 && val <= 25,
		error: 'Threshold must be between 1 and 25.',
		format: val => `\`${val}\``,
		fieldName: 'Threshold'
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
		)
		.addSubcommand(sc =>
			sc
				.setName('toggle-247')
				.setDescription('Toggle 24/7 mode (bot stays in voice channel when alone)')
		)
		.addSubcommand(sc =>
			sc
				.setName('set-starboard-channel')
				.setDescription('Channel for starboard highlights')
				.addChannelOption(o => o.setName('starboard-channel').setDescription('Text channel').setRequired(true))
		)
		.addSubcommand(sc =>
			sc
				.setName('set-star-threshold')
				.setDescription('Minimum stars to post to starboard (1-25)')
				.addIntegerOption(o => o.setName('threshold').setDescription('Number of stars required').setRequired(true).setMinValue(1).setMaxValue(25))
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
				{ name: '24/7 Mode', value: guildProfile.twentyFourSevenMode ? '`Enabled`' : '`Disabled`', inline: true },
				{ name: 'Starboard Chan', value: guildProfile.starboardChannelID ? `<#${guildProfile.starboardChannelID}>` : '`Not set`', inline: true },
				{ name: 'Star Threshold', value: `\`${guildProfile.starThreshold || 3}\``, inline: true },
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
		
		// Handle toggle type (24/7 mode)
		if (cfg.type === 'toggle') {
			const currentValue = guildProfile[cfg.column] ? 1 : 0;
			const newValue = currentValue ? 0 : 1;
			
			await db.pool.query(
				`UPDATE Guilds SET ${cfg.column} = ? WHERE guildId = ?`,
				[newValue, interaction.guildId]
			);
			
			invalidateGuildCache(interaction.guildId);
			guildProfile[cfg.column] = newValue;
			
			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | ${cfg.title}`)
				.addFields(
					{ name: cfg.fieldName, value: newValue ? '`Enabled`' : '`Disabled`', inline: true },
					{ name: 'Set by', value: `${interaction.user}`, inline: true }
				)
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');
			
			return interaction.editReply({ embeds: [embed] });
		}
		
		// Handle integer type (e.g. star threshold)
		if (cfg.type === 'integer') {
			const value = interaction.options.getInteger(cfg.option);

			if (!cfg.validate(value)) {
				const embed = new EmbedBuilder()
					.setDescription(`${interaction.client.emotes.error} | ${cfg.error}`)
					.setColor('#ff0000')
					.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
				return interaction.editReply({ embeds: [embed] });
			}

			await db.pool.query(
				`UPDATE Guilds SET ${cfg.column} = ? WHERE guildId = ?`,
				[value, interaction.guildId]
			);

			invalidateGuildCache(interaction.guildId);
			guildProfile[cfg.column] = value;

			const embed = new EmbedBuilder()
				.setTitle(`${interaction.client.emotes.success} | ${cfg.title}`)
				.addFields(
					{ name: cfg.fieldName, value: cfg.format(value), inline: true },
					{ name: 'Set by', value: `${interaction.user}`, inline: true }
				)
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
				.setColor('#ff006a');

			return interaction.editReply({ embeds: [embed] });
		}

		// pull the raw option (Role or Channel)
		const target = cfg.type === 'role'
			? interaction.options.getRole(cfg.option)
			: interaction.options.getChannel(cfg.option);

		// validation
		if (!cfg.validate(target)) {
			const embed = new EmbedBuilder()
				.setDescription(`${interaction.client.emotes.error} | ${cfg.error.replace('🚫 ', '')}`)
				.setColor('#ff0000')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
			return interaction.editReply({ embeds: [embed] });
		}

		// perform the DB update
		await db.pool.query(
			`UPDATE Guilds SET ${cfg.column} = ? WHERE guildId = ?`,
			[target.id, interaction.guildId]
		);

		// Clear the guild cache so the new setting takes effect immediately
		invalidateGuildCache(interaction.guildId);

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
