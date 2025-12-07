const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database/db.js');
const { request } = require('undici');
const logger = require('../logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('youtube')
        .setDescription('Configure YouTube notifications.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sc =>
            sc
                .setName('add')
                .setDescription('Add a YouTube channel to the notification list.')
                .addStringOption(o =>
                    o
                        .setName('handle')
                        .setDescription('The @handle of the YouTube channel to add.')
                        .setRequired(true)
                )
        )
        .addSubcommand(sc =>
            sc
                .setName('remove')
                .setDescription('Remove a YouTube channel from the notification list.')
                .addStringOption(o =>
                    o
                        .setName('handle')
                        .setDescription('The @handle of the YouTube channel to remove.')
                        .setRequired(true)
                )
        )
        .addSubcommand(sc =>
            sc
                .setName('view')
                .setDescription('View the YouTube notification list.')
        ),


    async execute(interaction, guildProfile) {
        const sub = interaction.options.getSubcommand();

        try {
            // -- ADD --
            if (sub === 'add') {
                const handleRaw = interaction.options.getString('handle');
                const handle = handleRaw.replace(/^@/, '');

                if (!guildProfile.youtubeChannelID) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${interaction.client.emotes.error} | You haven't set a YouTube notifications channel. Run \`/settings set-youtube-channel\` first.`)
                        .setColor('#ff0000')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }

                const channelData = await fetchYouTubeChannel(handle);
                if (!channelData) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${interaction.client.emotes.error} | Invalid YouTube handle—please try again.`)
                        .setColor('#ff0000')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }

                const { snippet, statistics, id: channelId } = channelData;
                try {
                    await db.pool.query(
                        'INSERT INTO Youtube (handle, channelId, guildId, lastChecked) VALUES (?, ?, ?, ?)',
                        [handle, channelId, interaction.guildId, new Date()]
                    );
                } catch (err) {
                    if (err.code === 'ER_DUP_ENTRY') {
                        const embed = new EmbedBuilder()
                            .setDescription(`${interaction.client.emotes.error} | That channel is already in the notification list.`)
                            .setColor('#ff0000')
                            .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                        return interaction.editReply({ embeds: [embed] });
                    }
                    logger.error('DB insert error: ' + (err.stack || err));
                    const errEmbed = new EmbedBuilder()
                        .setDescription(`${interaction.client.emotes.error} | Database error—please try again later.`)
                        .setColor('#ff0000')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [errEmbed] });
                }

                const embed = new EmbedBuilder()
                    .setTitle(`${interaction.client.emotes.success} | YouTube Channel Added`)
                    .setURL(`https://www.youtube.com/@${handle}`)
                    .setThumbnail(snippet.thumbnails.high.url)
                    .addFields(
                        { name: 'Name', value: snippet.title, inline: true },
                        { name: 'Subscribers', value: statistics.subscriberCount, inline: true },
                        { name: 'Videos', value: statistics.videoCount, inline: true }
                    )
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                    .setColor('#ff006a');

                return interaction.editReply({ embeds: [embed] });
            }

            // -- REMOVE --
            if (sub === 'remove') {
                const handleRaw = interaction.options.getString('handle');
                const handle = handleRaw.replace(/^@/, '');

                const [exists] = await db.pool.query(
                    'SELECT * FROM Youtube WHERE handle = ? AND guildId = ?',
                    [handle, interaction.guildId]
                );
                if (!exists.length) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${interaction.client.emotes.error} | That channel isn't in the notification list.`)
                        .setColor('#ff0000')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }

                await db.pool.query(
                    'DELETE FROM Youtube WHERE handle = ? AND guildId = ?',
                    [handle, interaction.guildId]
                );

                const channelData = await fetchYouTubeChannel(handle);
                const { snippet, statistics } = channelData;

                const embed = new EmbedBuilder()
                    .setTitle(`${interaction.client.emotes.success} | YouTube Channel Removed`)
                    .setURL(`https://www.youtube.com/@${handle}`)
                    .addFields(
                        { name: 'Name', value: snippet.title, inline: true },
                        { name: 'Subscribers', value: statistics.subscriberCount, inline: true },
                        { name: 'Videos', value: statistics.videoCount, inline: true }
                    )
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                    .setColor('#ff006a');

                return interaction.editReply({ embeds: [embed] });
            }

            // -- VIEW --
            if (sub === 'view') {
                const [rows] = await db.pool.query(
                    'SELECT * FROM Youtube WHERE guildId = ?',
                    [interaction.guildId]
                );
                if (!rows.length) {
                    const embed = new EmbedBuilder()
                        .setDescription(`ℹ️ No YouTube channels configured.`)
                        .setColor('#ff006a')
                        .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                    return interaction.editReply({ embeds: [embed] });
                }

                const fields = [];
                for (const row of rows) {
                    const channelData = await fetchYouTubeChannel(row.handle);
                    const { snippet, statistics } = channelData;
                    fields.push({
                        name: snippet.title,
                        value: `[@\`${row.handle}\`](https://www.youtube.com/@${row.handle})\n` +
                            `Subs: ${statistics.subscriberCount} • Videos: ${statistics.videoCount}`,
                        inline: true
                    });
                }

                const embed = new EmbedBuilder()
                    .setTitle('YouTube Notification List')
                    .setThumbnail('https://i.imgur.com/FWS5J0N.png')
                    .setDescription('Channels I will notify you about:')
                    .addFields(fields)
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo })
                    .setColor('#ff006a');

                return interaction.editReply({ embeds: [embed] });
            }
        } catch (err) {
            logger.error('YouTube command error: ' + (err.stack || err));
            const embed = new EmbedBuilder()
                .setDescription(`${interaction.client.emotes.error} | An unexpected error occurred—please try again.`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [embed] });
        }
    }
};

/**
 * Fetches channel data by handle via YouTube Data API v3.
 * Returns the snippet & statistics plus id, or null on failure.
 */
async function fetchYouTubeChannel(handle) {
    try {
        const res = await request(
            `https://www.googleapis.com/youtube/v3/channels?` +
            `part=snippet,statistics&forUsername=${handle}&key=${process.env.YOUTUBE_API_KEY}`
        );
        const body = await res.body.json();
        if (!body.items || !body.items.length) return null;
        const { snippet, statistics, id } = body.items[0];
        return { snippet, statistics, id };
    } catch (e) {
    logger.error('YouTube API error: ' + (e.stack || e));
        return null;
    }
}
