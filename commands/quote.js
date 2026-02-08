const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
    ButtonStyle, ComponentType } = require('discord.js');
const db = require('../database/db.js');
const logger = require('../logger');

function quoteEmbed(quote, client) {
    return new EmbedBuilder()
        .setDescription(`> ${quote.messageContent}`)
        .addFields(
            { name: 'Author', value: `<@${quote.authorId}>`, inline: true },
            { name: 'Saved by', value: `<@${quote.savedBy}>`, inline: true },
            { name: 'Date', value: `<t:${Math.floor(new Date(quote.createdAt).getTime() / 1000)}:R>`, inline: true }
        )
        .setColor('#ff006a')
        .setFooter({ text: `Quote #${quote.id} \u2022 The Pack`, iconURL: client.logo });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('quote')
        .setDescription('Save and recall memorable quotes')
        .addSubcommand(sc => sc.setName('save')
            .setDescription('Save a message as a quote')
            .addStringOption(o => o.setName('message_id').setDescription('Message ID to save (right-click message > Copy ID)').setRequired(true))
        )
        .addSubcommand(sc => sc.setName('random')
            .setDescription('Get a random quote from this server')
        )
        .addSubcommand(sc => sc.setName('search')
            .setDescription('Search quotes by keyword')
            .addStringOption(o => o.setName('keyword').setDescription('Search term').setRequired(true).setMaxLength(100))
        )
        .addSubcommand(sc => sc.setName('user')
            .setDescription('Get a random quote from a specific user')
            .addUserOption(o => o.setName('member').setDescription('User to get quote from').setRequired(true))
        )
        .addSubcommand(sc => sc.setName('list')
            .setDescription('View all quotes (paginated)')
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const emotes = interaction.client.emotes;

        try {
            if (sub === 'save') {
                await handleSave(interaction, guildId, emotes);
            } else if (sub === 'random') {
                await handleRandom(interaction, guildId, emotes);
            } else if (sub === 'search') {
                await handleSearch(interaction, guildId, emotes);
            } else if (sub === 'user') {
                await handleUser(interaction, guildId, emotes);
            } else if (sub === 'list') {
                await handleList(interaction, guildId, emotes);
            }
        } catch (e) {
            logger.error('Quote command error', { error: e.message, stack: e.stack });
            const embed = new EmbedBuilder()
                .setDescription(`${emotes.error} | Something went wrong.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }
    },
};

async function handleSave(interaction, guildId, emotes) {
    const messageId = interaction.options.getString('message_id').trim();

    let message;
    try {
        message = await interaction.channel.messages.fetch(messageId);
    } catch {
        const embed = new EmbedBuilder()
            .setDescription(`${emotes.error} | Could not find that message in this channel.`)
            .setColor('#ff0000')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        return interaction.editReply({ embeds: [embed] });
    }

    if (!message.content && !message.embeds.length) {
        const embed = new EmbedBuilder()
            .setDescription(`${emotes.error} | That message has no text content to save.`)
            .setColor('#ff0000')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        return interaction.editReply({ embeds: [embed] });
    }

    const content = message.content || message.embeds[0]?.description || '[Embed content]';

    // Check for duplicate
    const [existing] = await db.pool.query(
        'SELECT id FROM Quotes WHERE guildId = ? AND messageId = ?',
        [guildId, messageId]
    );
    if (existing.length > 0) {
        const embed = new EmbedBuilder()
            .setDescription(`${emotes.error} | That message is already saved as quote #${existing[0].id}.`)
            .setColor('#ff0000')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        return interaction.editReply({ embeds: [embed] });
    }

    await db.pool.query(
        `INSERT INTO Quotes (guildId, messageContent, authorId, authorUsername, savedBy, channelId, messageId)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [guildId, content.substring(0, 2000), message.author.id, message.author.username,
         interaction.user.id, interaction.channelId, messageId]
    );

    const embed = new EmbedBuilder()
        .setTitle(`${emotes.success} | Quote Saved`)
        .setDescription(`> ${content.substring(0, 500)}`)
        .addFields(
            { name: 'Author', value: `${message.author}`, inline: true },
            { name: 'Saved by', value: `${interaction.user}`, inline: true }
        )
        .setColor('#00ff00')
        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
    return interaction.editReply({ embeds: [embed] });
}

async function handleRandom(interaction, guildId, emotes) {
    const [rows] = await db.pool.query(
        'SELECT * FROM Quotes WHERE guildId = ? ORDER BY RAND() LIMIT 1',
        [guildId]
    );

    if (rows.length === 0) {
        const embed = new EmbedBuilder()
            .setDescription(`${emotes.error} | No quotes saved in this server yet. Use \`/quote save\` to add one!`)
            .setColor('#ff0000')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        return interaction.editReply({ embeds: [embed] });
    }

    return interaction.editReply({ embeds: [quoteEmbed(rows[0], interaction.client)] });
}

async function handleSearch(interaction, guildId, emotes) {
    const keyword = interaction.options.getString('keyword');

    // Try FULLTEXT first, fallback to LIKE
    let [rows] = await db.pool.query(
        'SELECT * FROM Quotes WHERE guildId = ? AND MATCH(messageContent) AGAINST(? IN BOOLEAN MODE) LIMIT 10',
        [guildId, keyword]
    );

    if (rows.length === 0) {
        [rows] = await db.pool.query(
            'SELECT * FROM Quotes WHERE guildId = ? AND messageContent LIKE ? LIMIT 10',
            [guildId, `%${keyword}%`]
        );
    }

    if (rows.length === 0) {
        const embed = new EmbedBuilder()
            .setDescription(`${emotes.error} | No quotes found matching "${keyword}".`)
            .setColor('#ff0000')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        return interaction.editReply({ embeds: [embed] });
    }

    const list = rows.map((q, i) =>
        `**${i + 1}.** > ${q.messageContent.substring(0, 80)}${q.messageContent.length > 80 ? '...' : ''}\n\u2003\u2014 <@${q.authorId}> (Quote #${q.id})`
    ).join('\n\n');

    const embed = new EmbedBuilder()
        .setTitle(`Search Results: "${keyword}"`)
        .setDescription(list)
        .setColor('#ff006a')
        .setFooter({ text: `${rows.length} result${rows.length !== 1 ? 's' : ''} \u2022 The Pack`, iconURL: interaction.client.logo });
    return interaction.editReply({ embeds: [embed] });
}

async function handleUser(interaction, guildId, emotes) {
    const member = interaction.options.getUser('member');

    const [rows] = await db.pool.query(
        'SELECT * FROM Quotes WHERE guildId = ? AND authorId = ? ORDER BY RAND() LIMIT 1',
        [guildId, member.id]
    );

    if (rows.length === 0) {
        const embed = new EmbedBuilder()
            .setDescription(`${emotes.error} | No quotes saved from ${member}.`)
            .setColor('#ff0000')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        return interaction.editReply({ embeds: [embed] });
    }

    return interaction.editReply({ embeds: [quoteEmbed(rows[0], interaction.client)] });
}

async function handleList(interaction, guildId, emotes) {
    const perPage = 5;

    const [[{ total }]] = await db.pool.query(
        'SELECT COUNT(*) as total FROM Quotes WHERE guildId = ?', [guildId]
    );

    if (total === 0) {
        const embed = new EmbedBuilder()
            .setDescription(`${emotes.error} | No quotes saved in this server yet.`)
            .setColor('#ff0000')
            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
        return interaction.editReply({ embeds: [embed] });
    }

    const totalPages = Math.ceil(total / perPage);
    let currentPage = 0;

    const fetchPage = async (page) => {
        const [rows] = await db.pool.query(
            'SELECT * FROM Quotes WHERE guildId = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?',
            [guildId, perPage, page * perPage]
        );
        const list = rows.map(q =>
            `**#${q.id}** > ${q.messageContent.substring(0, 100)}${q.messageContent.length > 100 ? '...' : ''}\n\u2003\u2014 <@${q.authorId}>`
        ).join('\n\n');

        return new EmbedBuilder()
            .setTitle('Saved Quotes')
            .setDescription(list)
            .setColor('#ff006a')
            .setFooter({ text: `Page ${page + 1}/${totalPages} \u2022 ${total} quotes \u2022 The Pack`, iconURL: interaction.client.logo });
    };

    const createButtons = (page) => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('quote_prev').setEmoji('\u25C0\uFE0F').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId('quote_next').setEmoji('\u25B6\uFE0F').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
    );

    const embed = await fetchPage(0);
    const message = await interaction.editReply({
        embeds: [embed],
        components: totalPages > 1 ? [createButtons(0)] : []
    });

    if (totalPages <= 1) return;

    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 120000,
    });

    collector.on('collect', async (i) => {
        if (i.user.id !== interaction.user.id) {
            return i.reply({ content: 'Only the person who ran the command can use these buttons.', ephemeral: true });
        }
        if (i.customId === 'quote_prev') currentPage = Math.max(0, currentPage - 1);
        else if (i.customId === 'quote_next') currentPage = Math.min(totalPages - 1, currentPage + 1);

        const pageEmbed = await fetchPage(currentPage);
        await i.update({ embeds: [pageEmbed], components: [createButtons(currentPage)] });
    });

    collector.on('end', () => {
        interaction.editReply({ components: [] }).catch(() => {});
    });
}
