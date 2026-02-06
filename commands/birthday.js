const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database/db.js');
const logger = require('../logger');

const MONTHS = [
	'January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December'
];

function formatDate(month, day) {
	return `${MONTHS[month - 1]} ${day}`;
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('birthday')
		.setDescription('Manage birthday reminders.')
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.addSubcommand(sc =>
			sc
				.setName('add')
				.setDescription('Add a birthday to the reminder list.')
				.addUserOption(o =>
					o
						.setName('user')
						.setDescription('The person whose birthday to add.')
						.setRequired(true)
				)
				.addStringOption(o =>
					o
						.setName('date')
						.setDescription('Birthday date in MM-DD format (e.g. 03-15 for March 15).')
						.setRequired(true)
				)
		)
		.addSubcommand(sc =>
			sc
				.setName('remove')
				.setDescription('Remove a birthday from the reminder list.')
				.addUserOption(o =>
					o
						.setName('user')
						.setDescription('The person whose birthday to remove.')
						.setRequired(true)
				)
		)
		.addSubcommand(sc =>
			sc
				.setName('list')
				.setDescription('View all saved birthdays.')
		),

	async execute(interaction) {
		const sub = interaction.options.getSubcommand();

		try {
			// -- ADD --
			if (sub === 'add') {
				const user = interaction.options.getUser('user');
				const dateStr = interaction.options.getString('date');

				const match = dateStr.match(/^(\d{1,2})-(\d{1,2})$/);
				if (!match) {
					const embed = new EmbedBuilder()
						.setDescription(`${interaction.client.emotes.error} | Invalid date format. Use MM-DD (e.g. \`03-15\` for March 15).`)
						.setColor('#ff0000')
						.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
					return interaction.editReply({ embeds: [embed] });
				}

				const month = parseInt(match[1], 10);
				const day = parseInt(match[2], 10);

				if (month < 1 || month > 12 || day < 1 || day > 31) {
					const embed = new EmbedBuilder()
						.setDescription(`${interaction.client.emotes.error} | Invalid date. Month must be 1-12 and day must be 1-31.`)
						.setColor('#ff0000')
						.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
					return interaction.editReply({ embeds: [embed] });
				}

				try {
					await db.pool.query(
						`INSERT INTO Birthdays (guildId, userId, name, birthMonth, birthDay)
						 VALUES (?, ?, ?, ?, ?)
						 ON DUPLICATE KEY UPDATE name = VALUES(name), birthMonth = VALUES(birthMonth), birthDay = VALUES(birthDay)`,
						[interaction.guildId, user.id, user.displayName, month, day]
					);
				} catch (err) {
					logger.error('DB insert error (birthday): ' + (err.stack || err));
					const embed = new EmbedBuilder()
						.setDescription(`${interaction.client.emotes.error} | Database error—please try again later.`)
						.setColor('#ff0000')
						.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
					return interaction.editReply({ embeds: [embed] });
				}

				const embed = new EmbedBuilder()
					.setTitle(`${interaction.client.emotes.success} | Birthday Added`)
					.setDescription(`**${user.displayName}**'s birthday has been set to **${formatDate(month, day)}**.`)
					.setThumbnail(user.displayAvatarURL({ size: 128 }))
					.setColor('#ff006a')
					.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

				return interaction.editReply({ embeds: [embed] });
			}

			// -- REMOVE --
			if (sub === 'remove') {
				const user = interaction.options.getUser('user');

				const [result] = await db.pool.query(
					'DELETE FROM Birthdays WHERE userId = ? AND guildId = ?',
					[user.id, interaction.guildId]
				);

				if (result.affectedRows === 0) {
					const embed = new EmbedBuilder()
						.setDescription(`${interaction.client.emotes.error} | ${user.displayName} doesn't have a birthday saved.`)
						.setColor('#ff0000')
						.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
					return interaction.editReply({ embeds: [embed] });
				}

				const embed = new EmbedBuilder()
					.setTitle(`${interaction.client.emotes.success} | Birthday Removed`)
					.setDescription(`**${user.displayName}**'s birthday has been removed.`)
					.setColor('#ff006a')
					.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

				return interaction.editReply({ embeds: [embed] });
			}

			// -- LIST --
			if (sub === 'list') {
				const [rows] = await db.pool.query(
					'SELECT userId, name, birthMonth, birthDay FROM Birthdays WHERE guildId = ? ORDER BY birthMonth, birthDay',
					[interaction.guildId]
				);

				if (!rows.length) {
					const embed = new EmbedBuilder()
						.setDescription('No birthdays saved yet. Use `/birthday add` to add some!')
						.setColor('#ff006a')
						.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
					return interaction.editReply({ embeds: [embed] });
				}

				const lines = rows.map(r => `<@${r.userId}> — **${formatDate(r.birthMonth, r.birthDay)}**`);

				const embed = new EmbedBuilder()
					.setTitle('Birthdays')
					.setDescription(lines.join('\n'))
					.setColor('#ff006a')
					.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

				return interaction.editReply({ embeds: [embed] });
			}
		} catch (err) {
			logger.error('Birthday command error: ' + (err.stack || err));
			const embed = new EmbedBuilder()
				.setDescription(`${interaction.client.emotes.error} | An unexpected error occurred—please try again.`)
				.setColor('#ff0000')
				.setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
			return interaction.editReply({ embeds: [embed] });
		}
	}
};
