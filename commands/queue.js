const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Show the current queue')
        .addIntegerOption(option =>
            option.setName('page')
                .setDescription('Page number to view')
                .setRequired(false)
                .setMinValue(1)
        ),
    async execute(interaction) {
        // Defer reply if not already deferred
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }

        const subscription = interaction.client.subscriptions.get(interaction.guildId);
        if (!subscription || (subscription.queue.length === 0 && !subscription.currentTrack)) {
            return interaction.editReply('❌ Queue is empty.');
        }

        const queue = subscription.queue;
        const current = subscription.currentTrack;
        const tracksPerPage = 10;
        const totalPages = Math.max(1, Math.ceil(queue.length / tracksPerPage));
        let currentPage = (interaction.options.getInteger('page') || 1) - 1;
        
        // Clamp page number
        currentPage = Math.max(0, Math.min(currentPage, totalPages - 1));

        const createEmbed = (page) => {
            const start = page * tracksPerPage;
            const end = start + tracksPerPage;
            const pageQueue = queue.slice(start, end);
            
            // Calculate total duration of known tracks
            const totalSeconds = queue.reduce((acc, t) => acc + (t.duration || 0), 0) + (current?.duration || 0);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const durationStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
            
            // Format current track
            let description = '**__Now Playing:__**\n';
            if (current) {
                const progress = '▶️';
                const currentDuration = current.formattedDuration || formatDuration(current.duration);
                const currentUrl = current.displayUrl || current.url;
                description += `${progress} [${current.title}](${currentUrl || '#'}) \`[${currentDuration}]\`\n`;
                description += `┗ Requested by: ${current.requestedBy}\n\n`;
            } else {
                description += 'Nothing playing\n\n';
            }
            
            // Format queue
            if (queue.length > 0) {
                description += '**__Up Next:__**\n';
                pageQueue.forEach((track, index) => {
                    const position = start + index + 1;
                    const duration = track.duration ? formatDuration(track.duration) : '??:??';
                    const trackUrl = track.displayUrl || track.url;
                    const status = track.url ? '' : ' 🔍'; // Search indicator for unresolved tracks
                    description += `\`${position}.\` [${track.title}](${trackUrl || '#'}) \`[${duration}]\`${status}\n`;
                    description += `┗ ${track.requestedBy}\n`;
                });
            } else {
                description += '*No more tracks in queue*';
            }
            
            const embed = new EmbedBuilder()
                .setTitle(`📜 Queue for ${interaction.guild.name}`)
                .setDescription(description)
                .setColor('#ff006a')
                .setFooter({ 
                    text: `Page ${page + 1}/${totalPages} • ${queue.length} song${queue.length !== 1 ? 's' : ''} • ${durationStr} total • Loop: ${getLoopMode(subscription.repeatMode)}`,
                    iconURL: interaction.client.logo 
                });
            
            return embed;
        };

        const createButtons = (page) => {
            return new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('queue_first')
                        .setEmoji('⏮️')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId('queue_prev')
                        .setEmoji('◀️')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId('queue_next')
                        .setEmoji('▶️')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page >= totalPages - 1),
                    new ButtonBuilder()
                        .setCustomId('queue_last')
                        .setEmoji('⏭️')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page >= totalPages - 1),
                );
        };

        const message = await interaction.editReply({
            embeds: [createEmbed(currentPage)],
            components: totalPages > 1 ? [createButtons(currentPage)] : []
        });

        if (totalPages <= 1) return;

        // Button collector
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 120000 // 2 minutes
        });

        collector.on('collect', async (i) => {
            // Only allow the original user to interact
            if (i.user.id !== interaction.user.id) {
                return i.reply({ content: 'Only the person who ran the command can use these buttons.', ephemeral: true });
            }

            switch (i.customId) {
                case 'queue_first':
                    currentPage = 0;
                    break;
                case 'queue_prev':
                    currentPage = Math.max(0, currentPage - 1);
                    break;
                case 'queue_next':
                    currentPage = Math.min(totalPages - 1, currentPage + 1);
                    break;
                case 'queue_last':
                    currentPage = totalPages - 1;
                    break;
            }

            await i.update({
                embeds: [createEmbed(currentPage)],
                components: [createButtons(currentPage)]
            });
        });

        collector.on('end', () => {
            // Remove buttons when collector expires
            interaction.editReply({ components: [] }).catch(() => {});
        });
    },
};

function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '??:??';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getLoopMode(mode) {
    switch (mode) {
        case 1: return '🔂 Song';
        case 2: return '🔁 Queue';
        default: return 'Off';
    }
}
