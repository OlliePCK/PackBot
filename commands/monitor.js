const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const logger = require('../logger');
const { detectSiteType, getSupportedSiteTypes } = require('../utils/siteParsers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('monitor')
        .setDescription('Monitor pages for changes (drops, tickets, restocks)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Add a new page monitor')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('A friendly name for this monitor')
                        .setRequired(true)
                        .setMaxLength(100)
                )
                .addStringOption(opt =>
                    opt.setName('url')
                        .setDescription('The URL to monitor')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt.setName('type')
                        .setDescription('Site type (auto-detected if not specified)')
                        .setRequired(false)
                        .addChoices(
                            { name: '🔄 Auto-detect', value: 'auto' },
                            { name: '🛒 Shopify (stock, price, variants)', value: 'shopify' },
                            { name: '🎟️ Ticketmaster / Live Nation', value: 'ticketmaster' },
                            { name: '🎫 Ticketek (AU/NZ)', value: 'ticketek' },
                            { name: '🎪 AXS Tickets', value: 'axs' },
                            { name: '📅 Eventbrite', value: 'eventbrite' },
                            { name: '📄 Generic (any website)', value: 'generic' }
                        )
                )
                .addStringOption(opt =>
                    opt.setName('keywords')
                        .setDescription('Keywords to trigger on (comma-separated). Leave empty for smart detection.')
                        .setRequired(false)
                )
                .addIntegerOption(opt =>
                    opt.setName('interval')
                        .setDescription('Check interval in seconds (min: 30, default: 60)')
                        .setRequired(false)
                        .setMinValue(30)
                        .setMaxValue(3600)
                )
                .addRoleOption(opt =>
                    opt.setName('ping_role')
                        .setDescription('Role to ping when changes are detected')
                        .setRequired(false)
                )
                .addChannelOption(opt =>
                    opt.setName('channel')
                        .setDescription('Channel to send alerts to (default: current channel)')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a page monitor')
                .addIntegerOption(opt =>
                    opt.setName('id')
                        .setDescription('The monitor ID to remove')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all page monitors for this server')
        )
        .addSubcommand(sub =>
            sub.setName('pause')
                .setDescription('Pause a page monitor')
                .addIntegerOption(opt =>
                    opt.setName('id')
                        .setDescription('The monitor ID to pause')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('resume')
                .setDescription('Resume a paused page monitor')
                .addIntegerOption(opt =>
                    opt.setName('id')
                        .setDescription('The monitor ID to resume')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('test')
                .setDescription('Test a monitor by fetching the page now')
                .addIntegerOption(opt =>
                    opt.setName('id')
                        .setDescription('The monitor ID to test')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('info')
                .setDescription('Get detailed info about a monitor')
                .addIntegerOption(opt =>
                    opt.setName('id')
                        .setDescription('The monitor ID')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('help')
                .setDescription('Learn how to use the page monitor')
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const pageMonitor = interaction.client.pageMonitor;

        if (!pageMonitor) {
            const errorEmbed = new EmbedBuilder()
                .setDescription('❌ Page monitor service is not available.')
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            return interaction.editReply({ embeds: [errorEmbed] });
        }

        // ═══════════════════════════════════════════════════════
        // HELP
        // ═══════════════════════════════════════════════════════
        if (sub === 'help') {
            const embed = new EmbedBuilder()
                .setTitle('📖 Page Monitor Guide')
                .setDescription('Monitor any webpage for changes and get instant Discord alerts — perfect for drops, restocks, ticket sales, and more!')
                .addFields(
                    {
                        name: '🚀 Quick Start',
                        value: '```/monitor add name:Nike Drop url:https://nike.com/launch```\nThe bot auto-detects the site type and uses smart monitoring!',
                    },
                    {
                        name: '🎯 Supported Site Types',
                        value: [
                            '🛒 **Shopify** — Tracks stock, prices, variants, restocks',
                            '🎟️ **Ticketmaster** — On-sale, presale, sold out detection',
                            '🎫 **Ticketek** — Australian/NZ ticketing',
                            '🎪 **AXS** — Concert/event tickets',
                            '📅 **Eventbrite** — Event registration',
                            '📄 **Generic** — Any webpage (keyword monitoring)',
                        ].join('\n'),
                    },
                    {
                        name: '🛒 Shopify Examples',
                        value: [
                            '```/monitor add name:Supreme Drop url:https://supremenewyork.com/products/jacket```',
                            'Alerts on: Stock changes, price drops, new variants, sold out/back in stock',
                        ].join('\n'),
                    },
                    {
                        name: '🎟️ Ticket Examples',
                        value: [
                            '```/monitor add name:Concert Tickets url:https://ticketmaster.com/event/xxx type:ticketmaster```',
                            'Alerts on: Tickets available, presale live, sold out',
                        ].join('\n'),
                    },
                    {
                        name: '📋 Management Commands',
                        value: [
                            '`/monitor list` — View all monitors',
                            '`/monitor info <id>` — Detailed stats & detected type',
                            '`/monitor test <id>` — Test fetch with parsed data',
                            '`/monitor pause <id>` — Pause monitoring',
                            '`/monitor resume <id>` — Resume monitoring',
                            '`/monitor remove <id>` — Delete a monitor',
                        ].join('\n'),
                    },
                    {
                        name: '💡 Tips',
                        value: [
                            '• Auto-detect usually works — only set type if needed',
                            '• Shopify monitors track per-variant stock levels',
                            '• Ticket monitors detect presale & general sale',
                            '• Use keywords for generic sites to filter noise',
                            '• Max 10 monitors per server',
                        ].join('\n'),
                    }
                )
                .setColor('#ff006a')
                .setFooter({ text: 'The Pack • Page Monitor', iconURL: interaction.client.logo });

            return interaction.editReply({ embeds: [embed] });
        }

        // ═══════════════════════════════════════════════════════
        // ADD
        // ═══════════════════════════════════════════════════════
        if (sub === 'add') {
            const name = interaction.options.getString('name');
            const url = interaction.options.getString('url');
            const monitorType = interaction.options.getString('type') || 'auto';
            const keywords = interaction.options.getString('keywords');
            const interval = interaction.options.getInteger('interval') || 60;
            const pingRole = interaction.options.getRole('ping_role');
            const channel = interaction.options.getChannel('channel') || interaction.channel;

            // Validate URL
            let parsedUrl;
            try {
                parsedUrl = new URL(url);
            } catch {
                const errorEmbed = new EmbedBuilder()
                    .setDescription('❌ Invalid URL format.')
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [errorEmbed] });
            }

            // Check monitor limit per guild (prevent abuse)
            const existing = await pageMonitor.getGuildMonitors(interaction.guild.id);
            if (existing.length >= 10) {
                const errorEmbed = new EmbedBuilder()
                    .setDescription('❌ Maximum of 10 monitors per server. Remove some to add more.')
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [errorEmbed] });
            }

            // Auto-detect site type for display
            const detectedType = monitorType === 'auto' ? detectSiteType(url) : monitorType;
            const typeEmoji = {
                shopify: '🛒',
                ticketmaster: '🎟️',
                ticketek: '🎫',
                axs: '🎪',
                eventbrite: '📅',
                generic: '📄',
            }[detectedType] || '📄';

            try {
                const monitor = await pageMonitor.addMonitor({
                    guildId: interaction.guild.id,
                    channelId: channel.id,
                    createdBy: interaction.user.id,
                    name,
                    url,
                    keywords,
                    checkInterval: interval,
                    roleToMention: pingRole?.id || null,
                    monitorType,
                });

                const embed = new EmbedBuilder()
                    .setTitle('✅ Monitor Created')
                    .setDescription(`Now monitoring **${name}**`)
                    .addFields(
                        { name: 'ID', value: `\`${monitor.id}\``, inline: true },
                        { name: 'Type', value: `${typeEmoji} ${detectedType}`, inline: true },
                        { name: 'Interval', value: `${interval}s`, inline: true },
                        { name: 'Alert Channel', value: `<#${channel.id}>`, inline: true },
                        { name: 'URL', value: url.length > 1024 ? url.slice(0, 1021) + '...' : url }
                    )
                    .setColor('#00ff00')
                    .setFooter({ text: 'The Pack • Page Monitor', iconURL: interaction.client.logo });

                // Add smart detection info based on type
                const smartFeatures = {
                    shopify: '📊 Tracking: Stock levels, price changes, variant availability',
                    ticketmaster: '🎫 Tracking: On-sale status, presales, availability',
                    ticketek: '🎫 Tracking: Ticket availability, presales',
                    axs: '🎫 Tracking: Ticket availability, presales',
                    eventbrite: '📅 Tracking: Registration status, availability',
                    generic: '📄 Tracking: Content changes' + (keywords ? ', keyword matches' : ''),
                }[detectedType];

                if (smartFeatures) {
                    embed.addFields({ name: 'Smart Detection', value: smartFeatures, inline: false });
                }

                if (keywords) {
                    embed.addFields({ name: 'Keywords', value: keywords, inline: false });
                }

                if (pingRole) {
                    embed.addFields({ name: 'Ping Role', value: `<@&${pingRole.id}>`, inline: true });
                }

                logger.info(`Monitor created: ${name}`, { 
                    guild: interaction.guild.name, 
                    user: interaction.user.tag,
                    url,
                    type: detectedType,
                });

                return interaction.editReply({ embeds: [embed] });

            } catch (error) {
                logger.error('Failed to create monitor', { error: error.message });
                const errorEmbed = new EmbedBuilder()
                    .setDescription('❌ Failed to create monitor. Please try again.')
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [errorEmbed] });
            }
        }

        // ═══════════════════════════════════════════════════════
        // REMOVE
        // ═══════════════════════════════════════════════════════
        if (sub === 'remove') {
            const id = interaction.options.getInteger('id');

            const removed = await pageMonitor.removeMonitor(id, interaction.guild.id);

            if (!removed) {
                const errorEmbed = new EmbedBuilder()
                    .setDescription('❌ Monitor not found or does not belong to this server.')
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [errorEmbed] });
            }

            const embed = new EmbedBuilder()
                .setTitle('🗑️ Monitor Removed')
                .setDescription(`Stopped monitoring **${removed.name}**`)
                .setColor('#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

            logger.info(`Monitor removed: ${removed.name}`, { 
                guild: interaction.guild.name, 
                user: interaction.user.tag 
            });

            return interaction.editReply({ embeds: [embed] });
        }

        // ═══════════════════════════════════════════════════════
        // LIST
        // ═══════════════════════════════════════════════════════
        if (sub === 'list') {
            const monitors = await pageMonitor.getGuildMonitors(interaction.guild.id);

            if (monitors.length === 0) {
                const infoEmbed = new EmbedBuilder()
                    .setTitle('📋 Page Monitors')
                    .setDescription('No page monitors set up yet.\n\nUse `/monitor add` to create one, or `/monitor help` to learn more.')
                    .setColor('#ff006a')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [infoEmbed] });
            }

            const typeEmojis = {
                shopify: '🛒',
                ticketmaster: '🎟️',
                ticketek: '🎫',
                axs: '🎪',
                eventbrite: '📅',
                generic: '📄',
                auto: '🔄',
            };

            const monitorList = monitors.map(m => {
                const status = m.isActive ? '🟢' : '🔴';
                const typeEmoji = typeEmojis[m.detectedType || m.monitorType] || '📄';
                const lastCheck = m.lastChecked 
                    ? `<t:${Math.floor(new Date(m.lastChecked).getTime() / 1000)}:R>`
                    : 'Never';
                
                let line = `${status} ${typeEmoji} **${m.name}** (ID: \`${m.id}\`)`;
                line += `\n   └ Every ${m.checkInterval}s • Last: ${lastCheck}`;
                
                if (m.errorCount > 0) {
                    line += ` • ⚠️ ${m.errorCount} error(s)`;
                }
                
                return line;
            }).join('\n\n');

            const embed = new EmbedBuilder()
                .setTitle('📋 Page Monitors')
                .setDescription(monitorList)
                .setColor('#ff006a')
                .setFooter({ text: `${monitors.length}/10 monitors • The Pack`, iconURL: interaction.client.logo });

            return interaction.editReply({ embeds: [embed] });
        }

        // ═══════════════════════════════════════════════════════
        // PAUSE
        // ═══════════════════════════════════════════════════════
        if (sub === 'pause') {
            const id = interaction.options.getInteger('id');

            const monitor = await pageMonitor.getMonitor(id, interaction.guild.id);

            if (!monitor) {
                const errorEmbed = new EmbedBuilder()
                    .setDescription('❌ Monitor not found or does not belong to this server.')
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [errorEmbed] });
            }

            if (!monitor.isActive) {
                const errorEmbed = new EmbedBuilder()
                    .setDescription('❌ This monitor is already paused.')
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [errorEmbed] });
            }

            await pageMonitor.pauseMonitor(id);

            const embed = new EmbedBuilder()
                .setTitle('⏸️ Monitor Paused')
                .setDescription(`**${monitor.name}** has been paused.`)
                .addFields({ name: 'Resume', value: `Use \`/monitor resume ${id}\` to restart`, inline: false })
                .setColor('#ffaa00')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

            return interaction.editReply({ embeds: [embed] });
        }

        // ═══════════════════════════════════════════════════════
        // RESUME
        // ═══════════════════════════════════════════════════════
        if (sub === 'resume') {
            const id = interaction.options.getInteger('id');

            const monitor = await pageMonitor.resumeMonitor(id, interaction.guild.id);

            if (!monitor) {
                const errorEmbed = new EmbedBuilder()
                    .setDescription('❌ Monitor not found or does not belong to this server.')
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [errorEmbed] });
            }

            const embed = new EmbedBuilder()
                .setTitle('▶️ Monitor Resumed')
                .setDescription(`**${monitor.name}** is now active again.`)
                .setColor('#00ff00')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

            return interaction.editReply({ embeds: [embed] });
        }

        // ═══════════════════════════════════════════════════════
        // TEST
        // ═══════════════════════════════════════════════════════
        if (sub === 'test') {
            const id = interaction.options.getInteger('id');

            const monitor = await pageMonitor.getMonitor(id, interaction.guild.id);

            if (!monitor) {
                const errorEmbed = new EmbedBuilder()
                    .setDescription('❌ Monitor not found or does not belong to this server.')
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [errorEmbed] });
            }

            try {
                // Use the smart test method
                const testResult = await pageMonitor.testMonitor(id, interaction.guild.id);

                if (!testResult.success) {
                    throw new Error(testResult.error);
                }

                const data = testResult.data;
                const typeEmoji = {
                    shopify: '🛒',
                    ticketmaster: '🎟️',
                    ticketek: '🎫',
                    axs: '🎪',
                    eventbrite: '📅',
                    generic: '📄',
                }[data.type] || '📄';

                const embed = new EmbedBuilder()
                    .setTitle('🧪 Monitor Test')
                    .setDescription(`**${monitor.name}**`)
                    .addFields(
                        { name: 'Detected Type', value: `${typeEmoji} ${data.type}`, inline: true },
                        { name: 'Parse Status', value: data.success ? '✅ Success' : '❌ Failed', inline: true }
                    )
                    .setColor('#00ff00')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

                // Type-specific fields
                if (data.type === 'shopify') {
                    embed.addFields(
                        { name: 'Product', value: data.title || 'Unknown', inline: false },
                        { name: 'Total Stock', value: (data.totalStock ?? 'N/A').toString(), inline: true },
                        { name: 'Available', value: data.available ? '✅ Yes' : '❌ No', inline: true },
                        { name: 'Variants', value: (data.variants?.length || 0).toString(), inline: true }
                    );
                    if (data.priceRange) {
                        const priceStr = data.priceRange.min === data.priceRange.max 
                            ? `$${data.priceRange.min}`
                            : `$${data.priceRange.min} - $${data.priceRange.max}`;
                        embed.addFields({ name: 'Price', value: priceStr, inline: true });
                    }
                } else if (['ticketmaster', 'ticketek', 'axs', 'eventbrite'].includes(data.type)) {
                    embed.addFields(
                        { name: 'Event', value: data.title || 'Unknown', inline: false }
                    );
                    if (data.venue) {
                        embed.addFields({ name: 'Venue', value: data.venue, inline: true });
                    }
                    if (data.date) {
                        embed.addFields({ name: 'Date', value: data.date, inline: true });
                    }
                    // Status indicators
                    const statusParts = [];
                    if (data.status?.onSale) statusParts.push('✅ On Sale');
                    if (data.status?.presale) statusParts.push('⭐ Presale');
                    if (data.status?.soldOut) statusParts.push('❌ Sold Out');
                    if (statusParts.length > 0) {
                        embed.addFields({ name: 'Status', value: statusParts.join(' • '), inline: false });
                    }
                } else {
                    // Generic
                    embed.addFields(
                        { name: 'Page Title', value: data.title?.slice(0, 256) || 'Unknown', inline: false },
                        { name: 'Available', value: data.available ? '✅ Yes' : '❌ No', inline: true }
                    );
                    if (data.prices?.length > 0) {
                        embed.addFields({ name: 'Prices Found', value: data.prices.slice(0, 3).join(', '), inline: true });
                    }
                }

                // Check for keywords if set
                if (monitor.keywords && data.keywordMatches) {
                    const found = Object.entries(data.keywordMatches).filter(([, v]) => v).map(([k]) => k);
                    const notFound = Object.entries(data.keywordMatches).filter(([, v]) => !v).map(([k]) => k);
                    
                    let keywordStatus = '';
                    if (found.length > 0) keywordStatus += `✅ Found: ${found.join(', ')}\n`;
                    if (notFound.length > 0) keywordStatus += `❌ Not found: ${notFound.join(', ')}`;
                    
                    embed.addFields({ name: 'Keywords', value: keywordStatus.trim() || 'None checked', inline: false });
                }

                return interaction.editReply({ embeds: [embed] });

            } catch (error) {
                const embed = new EmbedBuilder()
                    .setTitle('🧪 Monitor Test Failed')
                    .setDescription(`**${monitor.name}**`)
                    .addFields({ name: 'Error', value: error.message })
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

                return interaction.editReply({ embeds: [embed] });
            }
        }

        // ═══════════════════════════════════════════════════════
        // INFO
        // ═══════════════════════════════════════════════════════
        if (sub === 'info') {
            const id = interaction.options.getInteger('id');

            const monitor = await pageMonitor.getMonitor(id, interaction.guild.id);

            if (!monitor) {
                const errorEmbed = new EmbedBuilder()
                    .setDescription('❌ Monitor not found or does not belong to this server.')
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                return interaction.editReply({ embeds: [errorEmbed] });
            }

            const status = monitor.isActive ? '🟢 Active' : '🔴 Paused';
            const typeEmoji = {
                shopify: '🛒',
                ticketmaster: '🎟️',
                ticketek: '🎫',
                axs: '🎪',
                eventbrite: '📅',
                generic: '📄',
                auto: '🔄',
            }[monitor.monitorType || monitor.detectedType] || '📄';
            const monitorTypeDisplay = monitor.detectedType || monitor.monitorType || 'auto';
            
            const lastChecked = monitor.lastChecked 
                ? `<t:${Math.floor(new Date(monitor.lastChecked).getTime() / 1000)}:F>`
                : 'Never';
            const lastChanged = monitor.lastChanged 
                ? `<t:${Math.floor(new Date(monitor.lastChanged).getTime() / 1000)}:F>`
                : 'Never';
            const created = `<t:${Math.floor(new Date(monitor.createdAt).getTime() / 1000)}:F>`;

            const embed = new EmbedBuilder()
                .setTitle(`📊 ${monitor.name}`)
                .addFields(
                    { name: 'ID', value: `\`${monitor.id}\``, inline: true },
                    { name: 'Status', value: status, inline: true },
                    { name: 'Type', value: `${typeEmoji} ${monitorTypeDisplay}`, inline: true },
                    { name: 'Interval', value: `${monitor.checkInterval}s`, inline: true },
                    { name: 'Alert Channel', value: `<#${monitor.channelId}>`, inline: true },
                    { name: 'Ping Role', value: monitor.roleToMention ? `<@&${monitor.roleToMention}>` : 'None', inline: true },
                    { name: 'URL', value: monitor.url.length > 1024 ? monitor.url.slice(0, 1021) + '...' : monitor.url },
                    { name: 'Keywords', value: monitor.keywords || 'Smart detection', inline: true },
                    { name: 'Last Checked', value: lastChecked, inline: true },
                    { name: 'Last Changed', value: lastChanged, inline: true },
                    { name: 'Created', value: created, inline: true }
                )
                .setColor('#ff006a')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

            if (monitor.errorCount > 0) {
                embed.addFields(
                    { name: '⚠️ Errors', value: `${monitor.errorCount} consecutive error(s)`, inline: true },
                    { name: 'Last Error', value: monitor.lastError?.slice(0, 256) || 'Unknown', inline: true }
                );
            }

            return interaction.editReply({ embeds: [embed] });
        }
    }
};
