const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const logger = require('../logger');

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
                    opt.setName('keywords')
                        .setDescription('Keywords to trigger on (comma-separated). Leave empty for any change.')
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
                .setDescription('Monitor any webpage for changes and get instant Discord alerts when something updates — perfect for drops, restocks, ticket sales, and more!')
                .addFields(
                    {
                        name: '🚀 Quick Start',
                        value: '```/monitor add name:Nike Drop url:https://nike.com/launch```\nThis creates a monitor that checks every 60 seconds and alerts on ANY change.',
                    },
                    {
                        name: '🔑 Keyword Filtering',
                        value: '```/monitor add name:Tickets url:https://site.com keywords:available,buy now```\nOnly alerts when "available" OR "buy now" appears on the page. Great for filtering out noise!',
                    },
                    {
                        name: '⚡ Faster Checks',
                        value: '```/monitor add name:Supreme url:https://supremenewyork.com interval:30```\nCheck every 30 seconds (minimum). Default is 60s, max is 3600s (1 hour).',
                    },
                    {
                        name: '🔔 Role Pings',
                        value: '```/monitor add name:PS5 Restock url:https://store.com ping_role:@Drops```\nPing a role when changes are detected so no one misses it.',
                    },
                    {
                        name: '📋 Management Commands',
                        value: [
                            '`/monitor list` — View all monitors',
                            '`/monitor info <id>` — Detailed monitor stats',
                            '`/monitor test <id>` — Test fetch a page now',
                            '`/monitor pause <id>` — Pause monitoring',
                            '`/monitor resume <id>` — Resume monitoring',
                            '`/monitor remove <id>` — Delete a monitor',
                        ].join('\n'),
                    },
                    {
                        name: '💡 Tips',
                        value: [
                            '• Use keywords to avoid spam from dynamic content',
                            '• Monitor password pages — alert when they go live',
                            '• Shorter intervals = faster alerts but more load',
                            '• Monitors auto-pause after 5 consecutive errors',
                            '• Max 10 monitors per server',
                        ].join('\n'),
                    },
                    {
                        name: '📝 Example Use Cases',
                        value: [
                            '**Sneaker drops:** Monitor Nike SNKRS, Shopify stores',
                            '**Tickets:** Concert/event pages for "on sale" keywords',
                            '**Restocks:** PS5, GPUs, limited items',
                            '**Password pages:** Know when a site goes live',
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
            const keywords = interaction.options.getString('keywords');
            const interval = interaction.options.getInteger('interval') || 60;
            const pingRole = interaction.options.getRole('ping_role');
            const channel = interaction.options.getChannel('channel') || interaction.channel;

            // Validate URL
            try {
                new URL(url);
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
                });

                const embed = new EmbedBuilder()
                    .setTitle('✅ Monitor Created')
                    .setDescription(`Now monitoring **${name}**`)
                    .addFields(
                        { name: 'ID', value: `\`${monitor.id}\``, inline: true },
                        { name: 'Interval', value: `${interval}s`, inline: true },
                        { name: 'Alert Channel', value: `<#${channel.id}>`, inline: true },
                        { name: 'URL', value: url.length > 1024 ? url.slice(0, 1021) + '...' : url }
                    )
                    .setColor('#00ff00')
                    .setFooter({ text: 'The Pack • Page Monitor', iconURL: interaction.client.logo });

                if (keywords) {
                    embed.addFields({ name: 'Keywords', value: keywords, inline: false });
                }

                if (pingRole) {
                    embed.addFields({ name: 'Ping Role', value: `<@&${pingRole.id}>`, inline: true });
                }

                logger.info(`Monitor created: ${name}`, { 
                    guild: interaction.guild.name, 
                    user: interaction.user.tag,
                    url 
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

            const monitorList = monitors.map(m => {
                const status = m.isActive ? '🟢' : '🔴';
                const lastCheck = m.lastChecked 
                    ? `<t:${Math.floor(new Date(m.lastChecked).getTime() / 1000)}:R>`
                    : 'Never';
                
                let line = `${status} **${m.name}** (ID: \`${m.id}\`)`;
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
                const response = await fetch(monitor.url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    },
                });

                const content = await response.text();
                const titleMatch = content.match(/<title>([^<]*)<\/title>/i);
                const pageTitle = titleMatch ? titleMatch[1].trim() : 'No title found';

                // Check for keywords if set
                let keywordStatus = 'N/A';
                if (monitor.keywords) {
                    const keywords = monitor.keywords.split(',').map(k => k.trim().toLowerCase());
                    const lowerContent = content.toLowerCase();
                    const found = keywords.filter(k => lowerContent.includes(k));
                    
                    if (found.length > 0) {
                        keywordStatus = `✅ Found: ${found.join(', ')}`;
                    } else {
                        keywordStatus = `❌ Not found: ${keywords.join(', ')}`;
                    }
                }

                const embed = new EmbedBuilder()
                    .setTitle('🧪 Monitor Test')
                    .setDescription(`**${monitor.name}**`)
                    .addFields(
                        { name: 'Status', value: `${response.status} ${response.statusText}`, inline: true },
                        { name: 'Content Length', value: `${content.length.toLocaleString()} bytes`, inline: true },
                        { name: 'Page Title', value: pageTitle.slice(0, 256) || 'None', inline: false }
                    )
                    .setColor('#00ff00')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });

                if (monitor.keywords) {
                    embed.addFields({ name: 'Keywords', value: keywordStatus, inline: false });
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
                    { name: 'Interval', value: `${monitor.checkInterval}s`, inline: true },
                    { name: 'URL', value: monitor.url.length > 1024 ? monitor.url.slice(0, 1021) + '...' : monitor.url },
                    { name: 'Alert Channel', value: `<#${monitor.channelId}>`, inline: true },
                    { name: 'Keywords', value: monitor.keywords || 'Any change', inline: true },
                    { name: 'Ping Role', value: monitor.roleToMention ? `<@&${monitor.roleToMention}>` : 'None', inline: true },
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
