const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
    ButtonStyle, ComponentType } = require('discord.js');
const db = require('../database/db.js');
const logger = require('../logger');

const BAR_LENGTH = 10;

function buildResultsText(options, votes) {
    const totalVotes = Object.values(votes).reduce((sum, arr) => sum + arr.length, 0);
    return options.map((opt, i) => {
        const count = (votes[String(i)] || []).length;
        const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        const filled = totalVotes > 0 ? Math.round((count / totalVotes) * BAR_LENGTH) : 0;
        const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(BAR_LENGTH - filled);
        return `**${i + 1}.** ${opt}\n${bar} ${count} vote${count !== 1 ? 's' : ''} (${pct}%)`;
    }).join('\n\n');
}

function buildEmbed(question, options, votes, createdBy, expiresAt, closed) {
    const totalVotes = Object.values(votes).reduce((sum, arr) => sum + arr.length, 0);
    const results = buildResultsText(options, votes);

    const embed = new EmbedBuilder()
        .setTitle(closed ? 'Poll Results' : 'Poll')
        .setDescription(`**${question}**\n\n${results}`)
        .setColor(closed ? '#00ff00' : '#ff006a')
        .setTimestamp();

    if (closed) {
        // Find winner(s)
        let maxVotes = 0;
        options.forEach((_, i) => {
            const count = (votes[String(i)] || []).length;
            if (count > maxVotes) maxVotes = count;
        });
        if (maxVotes > 0) {
            const winners = options.filter((_, i) => (votes[String(i)] || []).length === maxVotes);
            embed.addFields({ name: 'Winner', value: winners.join(', '), inline: true });
        }
        embed.addFields({ name: 'Total Votes', value: `${totalVotes}`, inline: true });
        embed.setFooter({ text: 'Poll closed' });
    } else {
        embed.setFooter({ text: `${totalVotes} vote${totalVotes !== 1 ? 's' : ''} \u2022 Ends` });
        embed.setTimestamp(expiresAt);
    }

    return embed;
}

function buildButtons(options, closed) {
    const row = new ActionRowBuilder();
    options.forEach((opt, i) => {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`poll_vote_${i}`)
                .setLabel(opt.length > 80 ? opt.substring(0, 77) + '...' : opt)
                .setStyle(ButtonStyle.Primary)
                .setDisabled(closed)
        );
    });
    return row;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Create a quick poll')
        .addStringOption(o => o.setName('question').setDescription('Poll question').setRequired(true).setMaxLength(500))
        .addStringOption(o => o.setName('option1').setDescription('First option').setRequired(true).setMaxLength(100))
        .addStringOption(o => o.setName('option2').setDescription('Second option').setRequired(true).setMaxLength(100))
        .addStringOption(o => o.setName('option3').setDescription('Third option (optional)').setRequired(false).setMaxLength(100))
        .addStringOption(o => o.setName('option4').setDescription('Fourth option (optional)').setRequired(false).setMaxLength(100))
        .addIntegerOption(o => o.setName('duration').setDescription('Duration in minutes (default 5, max 1440)').setRequired(false).setMinValue(1).setMaxValue(1440)),

    async execute(interaction) {
        const question = interaction.options.getString('question');
        const options = [
            interaction.options.getString('option1'),
            interaction.options.getString('option2'),
            interaction.options.getString('option3'),
            interaction.options.getString('option4'),
        ].filter(Boolean);

        const duration = interaction.options.getInteger('duration') || 5;
        const expiresAt = new Date(Date.now() + duration * 60000);

        // Initialize empty votes
        const votes = {};
        options.forEach((_, i) => { votes[String(i)] = []; });

        const embed = buildEmbed(question, options, votes, interaction.user.id, expiresAt, false);
        const row = buildButtons(options, false);

        const message = await interaction.editReply({ embeds: [embed], components: [row] });

        // Save to DB
        try {
            await db.pool.query(
                `INSERT INTO Polls (guildId, channelId, messageId, question, options, votes, createdBy, expiresAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [interaction.guildId, interaction.channelId, message.id, question,
                 JSON.stringify(options), JSON.stringify(votes), interaction.user.id, expiresAt]
            );
        } catch (e) {
            logger.error('Failed to save poll to DB', { error: e.message });
        }

        // Collect votes
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: duration * 60000,
        });

        collector.on('collect', async (i) => {
            const index = i.customId.replace('poll_vote_', '');

            // Remove user's previous vote if any
            for (const key of Object.keys(votes)) {
                const idx = votes[key].indexOf(i.user.id);
                if (idx !== -1) votes[key].splice(idx, 1);
            }

            // Add new vote
            if (!votes[index]) votes[index] = [];
            votes[index].push(i.user.id);

            // Update DB
            try {
                await db.pool.query('UPDATE Polls SET votes = ? WHERE messageId = ?',
                    [JSON.stringify(votes), message.id]);
            } catch (e) {
                logger.error('Failed to update poll votes', { error: e.message });
            }

            const updatedEmbed = buildEmbed(question, options, votes, interaction.user.id, expiresAt, false);
            await i.update({ embeds: [updatedEmbed], components: [row] });
        });

        collector.on('end', async () => {
            const finalEmbed = buildEmbed(question, options, votes, interaction.user.id, expiresAt, true);
            try {
                await interaction.editReply({ embeds: [finalEmbed], components: [] });
                await db.pool.query('UPDATE Polls SET closed = 1, votes = ? WHERE messageId = ?',
                    [JSON.stringify(votes), message.id]);
            } catch (e) {
                logger.error('Failed to close poll', { error: e.message });
            }
        });
    },
};
