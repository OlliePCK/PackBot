const db = require('../database/db.js');
const cron = require('node-cron');
const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const logger = require('../logger').child('birthdays');
const messages = require('../birthday-messages.json');

module.exports = client => {
	// Every day at 9:00 AM Melbourne time
	cron.schedule('0 9 * * *', () => {
		checkBirthdays().catch(e => logger.error('Birthday check error: ' + e.message));
	}, { timezone: 'Australia/Melbourne' });

	logger.info('Scheduled birthday reminders daily at 9:00 AM Australia/Melbourne');

	async function fetchFamousBirthdays(month, day) {
		try {
			const res = await axios.get(`https://today.zenquotes.io/api/${month}/${day}`, { timeout: 10000 });
			const births = res.data?.data?.Births;
			if (!Array.isArray(births) || !births.length) return [];

			// Pick up to 3 random famous birthdays
			const shuffled = births.sort(() => 0.5 - Math.random());
			return shuffled.slice(0, 3).map(b => {
				// Extract just the name from the text (format: "YEAR – Name, description (died YEAR)")
				const nameMatch = b.text.match(/^\d+\s*[–—-]\s*(.+?)(?:,\s|$)/);
				return nameMatch ? nameMatch[1].trim() : b.text.split('–')[1]?.trim()?.split(',')[0]?.trim();
			}).filter(Boolean);
		} catch (err) {
			logger.warn('Failed to fetch famous birthdays: ' + err.message);
			return [];
		}
	}

	async function checkBirthdays() {
		// Get current date in Melbourne timezone
		const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }));
		const month = now.getMonth() + 1;
		const day = now.getDate();

		logger.info(`Birthday check for ${month}-${day}`);

		const [rows] = await db.pool.query(
			`SELECT b.userId, b.name, b.birthMonth, b.birthDay, b.guildId, g.generalChannelID
			 FROM Birthdays b
			 JOIN Guilds g ON g.guildId = b.guildId
			 WHERE b.birthMonth = ? AND b.birthDay = ? AND g.generalChannelID IS NOT NULL`,
			[month, day]
		);

		if (!rows.length) {
			logger.debug('No birthdays today');
			return;
		}

		logger.info(`Found ${rows.length} birthday(s) today`);

		// Fetch famous birthdays once for the day
		const famousPeople = await fetchFamousBirthdays(month, day);

		// Group by channel so shared birthdays go in one message
		const byChannel = new Map();
		for (const row of rows) {
			const list = byChannel.get(row.generalChannelID) || [];
			list.push(row);
			byChannel.set(row.generalChannelID, list);
		}

		for (const [channelId, people] of byChannel) {
			try {
				const channel = await client.channels.fetch(channelId).catch(() => null);
				if (!channel?.isTextBased()) continue;

				// Pick a random custom message
				const customMsg = messages[Math.floor(Math.random() * messages.length)];

				// Build mentions and name list
				const mentions = people.map(p => `<@${p.userId}>`).join(' ');
				const names = people.map(p => `**${p.name}**`);

				let description;
				if (names.length === 1) {
					description = `It's ${names[0]}'s birthday today!\n\n*${customMsg}*`;
				} else {
					const allButLast = names.slice(0, -1).join(', ');
					description = `It's ${allButLast} and ${names[names.length - 1]}'s birthdays today!\n\n*${customMsg}*`;
				}

				// Add famous birthdays
				if (famousPeople.length) {
					description += `\n\nAlso born on this day: ${famousPeople.join(', ')}`;
				}

				const embed = new EmbedBuilder()
					.setTitle('Happy Birthday!')
					.setDescription(description)
					.setColor('#ff006a')
					.setFooter({ text: 'The Pack', iconURL: client.logo });

				await channel.send({ content: mentions, embeds: [embed] });

				const nameLog = people.map(p => p.name).join(', ');
				logger.info(`Sent birthday reminder for ${nameLog} in channel ${channelId}`);
			} catch (err) {
				logger.error(`Failed to send birthday reminder to channel ${channelId}: ${err.message}`);
			}
		}
	}
};
