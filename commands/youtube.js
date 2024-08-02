const discord = require('discord.js');
const { SlashCommandBuilder, PermissionsBitField, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../database/db.js');
const { request } = require('undici');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('youtube')
        .setDescription('Configure YouTube notifications.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Add a YouTube channel to the notification list.')
                .addStringOption(option =>
                    option.setName('handle')
                        .setDescription('The @handle of the YouTube channel to add.')
                        .setRequired(true)
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Remove a YouTube channel from the notification list.')
                .addStringOption(option =>
                    option.setName('handle')
                        .setDescription('The @handle of the YouTube channel to remove.')
                        .setRequired(true)
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('View the YouTube notification list.'),
        ),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.editReply('You aren\'t an admin!');
        }
        try {
            const [rows] = await db.pool.query('SELECT * FROM Guilds WHERE guildId = ?', [interaction.guildId]);
            const guildProfile = rows[0];
            if (interaction.options.getSubcommand() === 'add') {
                const handle = interaction.options.getString('handle');
                if (!guildProfile.youtubeChannelID) {
                    return interaction.editReply(`You haven't set a Discord channel for notifications yet. Use \`/settings set-youtube-channel youtube-channel\` to set one.`)
                }
                const channel = await verifyYouTubeChannel(handle);
                if (!channel) {
                    return interaction.editReply('Invalid YouTube Handle! Please try again.');
                } else {
                    const channelSnippet = channel.items[0].snippet;
                    try {
                        await db.pool.query('INSERT INTO Youtube (handle, channelId, guildId, lastChecked) VALUES (?, ?, ?, ?)', [handle, channel.items[0].id, interaction.guildId, new Date()]);
                    } catch (error) {
                        if (error.code === 'ER_DUP_ENTRY') {
                            return interaction.editReply('This YouTube channel is already in the notification list!');
                        } else {
                            console.error(error);
                            return interaction.editReply('An error occured while adding this YouTube channel!');
                        }
                    }
                    const embed = new EmbedBuilder()
                        .setTitle(`${interaction.client.emotes.success} | Added YouTube channel`)
                        .addFields(
                            { name: 'Name', value: channelSnippet.title, inline: true },
                            { name: 'Subscribers', value: channel.items[0].statistics.subscriberCount, inline: true },
                            { name: 'Videos', value: channel.items[0].statistics.videoCount, inline: true },
                        )
                        .setURL(`https://www.youtube.com/@${handle}`)
                        .setImage(channelSnippet.thumbnails.high.url)
                        .setFooter({
                            text: 'The Pack',
                            iconURL: interaction.client.logo
                        })
                        .setColor('#ff006a');
                    return interaction.editReply({ embeds: [embed] })
                }
            } else if (interaction.options.getSubcommand() === 'remove') {
                const handle = interaction.options.getString('handle');
                const [rows] = await db.pool.query('SELECT * FROM Youtube WHERE handle = ? AND guildId = ?', [handle, interaction.guildId]);
                if (!rows[0]) {
                    return interaction.editReply('This YouTube channel is not in the notification list!');
                } else {
                    await db.pool.query('DELETE FROM Youtube WHERE handle = ? AND guildId = ?', [handle, interaction.guildId]);
                    const channel = await getYouTubeChannel(handle);
                    const channelSnippet = channel.items[0].snippet;
                    const embed = new EmbedBuilder()
                        .setTitle(`${interaction.client.emotes.success} | Removed YouTube channel!`)
                        .addFields(
                            { name: 'Name', value: channelSnippet.title, inline: true },
                            { name: 'Subscribers', value: channel.items[0].statistics.subscriberCount, inline: true },
                            { name: 'Videos', value: channel.items[0].statistics.videoCount, inline: true },
                        )
                        .setURL(`https://www.youtube.com/@${handle}`)
                        .setFooter({
                            text: 'The Pack',
                            iconURL: interaction.client.logo
                        })
                        .setColor('#ff006a');
                    return interaction.editReply({ embeds: [embed] })
                }
            } else if (interaction.options.getSubcommand() === 'view') {
                const [rows] = await db.pool.query('SELECT * FROM Youtube WHERE guildId = ?', [interaction.guildId]);
                if (!rows[0]) {
                    return interaction.editReply('There are no YouTube channels in the notification list!');
                } else {
                    const fieldList = [];
                    for (const row of rows) {
                        const channel = await getYouTubeChannel(row.handle);
                        const channelSnippet = channel.items[0].snippet;
                        const entry = {
                            name: channelSnippet.title,
                            value: `[@\`${row.handle}\`](https://www.youtube.com/@${row.handle})\nSubscribers: ${channel.items[0].statistics.subscriberCount}\nVideos: ${channel.items[0].statistics.videoCount}`,
                            inline: true,
                        };
                        fieldList.push(entry);
                    }
                    const embed = new EmbedBuilder()
                        .setTitle('YouTube Notification List')
                        .setThumbnail('https://i.imgur.com/FWS5J0N.png')
                        .setDescription('Here are the YouTube channels in the notification list:')
                        .addFields(fieldList)
                        .setFooter({
                            text: 'The Pack',
                            iconURL: interaction.client.logo
                        })
                        .setColor('#ff006a');
                    return interaction.editReply({ embeds: [embed] });
                }
            }
        }
        catch (error) {
            console.error(error);
            return interaction.editReply('An error occured while executing this command!');
        }
    },
};

async function verifyYouTubeChannel(handle) {
    var channel = await getYouTubeChannel(handle);
    if (channel.pageInfo.totalResults === 1) {
        return channel; // Valid YouTube Handle
    } else {
        return false; // Invalid YouTube Handle
    }
}
async function getYouTubeChannel(handle) {
    try {
        const response = await request(`https://www.googleapis.com/youtube/v3/channels?part=snippet%2CcontentDetails%2Cstatistics&&forHandle=${handle}&key=${process.env.YOUTUBE_API_KEY}`);
        const channel = await response.body.json();
        return channel;
    } catch (error) {
        console.error(error);
        return false; // Error occurred during verification
    }
}