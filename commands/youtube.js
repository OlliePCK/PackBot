const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database/db.js');
const { request } = require('undici');

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
                    return interaction.editReply({
                        content: `🚫 You haven't set a YouTube notifications channel. Run \`/settings set-youtube-channel\` first.`
                    });
                }

                const channelData = await fetchYouTubeChannel(handle);
                if (!channelData) {
                    return interaction.editReply({ content: '🚫 Invalid YouTube handle—please try again.' });
                }

                const { snippet, statistics, id: channelId } = channelData;
                try {
                    await db.pool.query(
                        'INSERT INTO Youtube (handle, channelId, guildId, lastChecked) VALUES (?, ?, ?, ?)',
                        [handle, channelId, interaction.guildId, new Date()]
                    );
                } catch (err) {
                    if (err.code === 'ER_DUP_ENTRY') {
                        return interaction.editReply({ content: '🚫 That channel is already in the notification list.' });
                    }
                    console.error('DB insert error:', err);
                    return interaction.editReply({ content: '🚫 Database error—please try again later.' });
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
                    return interaction.editReply({ content: '🚫 That channel isn’t in the notification list.' });
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
                    return interaction.editReply({ content: 'ℹ️ No YouTube channels configured.' });
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
            console.error('YouTube command error:', err);
            return interaction.editReply({ content: '🚫 An unexpected error occurred—please try again.' });
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
        console.error('YouTube API error:', e);
        return null;
    }
}
