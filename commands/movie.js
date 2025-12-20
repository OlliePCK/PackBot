/**
 * /movie Command
 * IMAX Melbourne seat scanner - find optimal consecutive seating
 * Guild-restricted for security (credentials stored per-user)
 */

const { SlashCommandBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const logger = require('../logger').child('movie-command');
const { getImaxScannerService } = require('../services/ImaxScannerService');
const { storeCredentials, deleteCredentials, hasCredentials, prefillCheckout } = require('../utils/imaxCheckout');

// Guild restriction - only deploy and allow in this guild
const ALLOWED_GUILD = process.env.IMAX_ALLOWED_GUILD;

/**
 * Parse date input to YYYY-MM-DD format
 * @param {string} input - Date input (today, tomorrow, YYYY-MM-DD, DD/MM/YYYY, etc.)
 * @returns {string|null} Date in YYYY-MM-DD format or null if invalid
 */
function parseDate(input) {
    if (!input) {
        // Default to today
        const today = new Date();
        return today.toISOString().split('T')[0];
    }

    const lower = input.toLowerCase().trim();

    // Handle relative dates
    if (lower === 'today') {
        return new Date().toISOString().split('T')[0];
    }
    if (lower === 'tomorrow') {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        return tomorrow.toISOString().split('T')[0];
    }

    // Handle YYYY-MM-DD format
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
        return input;
    }

    // Handle DD/MM/YYYY or DD-MM-YYYY format
    const dmyMatch = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmyMatch) {
        const day = dmyMatch[1].padStart(2, '0');
        const month = dmyMatch[2].padStart(2, '0');
        const year = dmyMatch[3];
        return `${year}-${month}-${day}`;
    }

    // Handle DD/MM or DD-MM (assume current year)
    const dmMatch = input.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
    if (dmMatch) {
        const day = dmMatch[1].padStart(2, '0');
        const month = dmMatch[2].padStart(2, '0');
        const year = new Date().getFullYear();
        return `${year}-${month}-${day}`;
    }

    return null;
}

async function replyWith(interaction, payload) {
    if (interaction.deferred || interaction.replied) {
        return interaction.editReply(payload);
    }
    return interaction.reply(payload);
}

module.exports = {
    // Guild-only deployment - only registers in the allowed guild
    guildOnly: ALLOWED_GUILD || null,

    data: new SlashCommandBuilder()
        .setName('movie')
        .setDescription('IMAX Melbourne seat scanner')
        .addSubcommand(sub =>
            sub.setName('scan')
                .setDescription('Scan for optimal consecutive seating')
                .addStringOption(opt =>
                    opt.setName('movie')
                        .setDescription('IMAX movie URL or ID (e.g. session_times_and_tickets/?movie=810)')
                        .setRequired(true)
                )
                .addIntegerOption(opt =>
                    opt.setName('seats')
                        .setDescription('Number of consecutive seats needed (default: 2)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(10)
                )
        )
        .addSubcommand(sub =>
            sub.setName('sessions')
                .setDescription('List available sessions for a date')
                .addStringOption(opt =>
                    opt.setName('date')
                        .setDescription('Date to check (today, tomorrow, YYYY-MM-DD, DD/MM/YYYY)')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('check')
                .setDescription('Check a specific session for available seats')
                .addStringOption(opt =>
                    opt.setName('session_id')
                        .setDescription('Vista session ID (from session list or URL)')
                        .setRequired(true)
                )
                .addIntegerOption(opt =>
                    opt.setName('seats')
                        .setDescription('Number of consecutive seats needed (default: 2)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(10)
                )
        )
        .addSubcommand(sub =>
            sub.setName('login')
                .setDescription('Store your Big League credentials for auto-checkout')
        )
        .addSubcommand(sub =>
            sub.setName('logout')
                .setDescription('Remove your stored Big League credentials')
        )
        .addSubcommand(sub =>
            sub.setName('book')
                .setDescription('Scan and auto-select best seats, pre-fill checkout')
                .addStringOption(opt =>
                    opt.setName('movie')
                        .setDescription('IMAX movie URL or ID')
                        .setRequired(true)
                )
                .addIntegerOption(opt =>
                    opt.setName('seats')
                        .setDescription('Number of consecutive seats needed (default: 2)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(10)
                )
        ),

    async execute(interaction) {
        // Runtime guild check (defense in depth)
        if (ALLOWED_GUILD && interaction.guildId !== ALLOWED_GUILD) {
            logger.warn('Unauthorized guild attempted to use /movie', {
                guildId: interaction.guildId,
                userId: interaction.user.id,
            });
            return replyWith(interaction, {
                content: '❌ This command is not available in this server.',
                ephemeral: true,
            });
        }

        const subcommand = interaction.options.getSubcommand();
        const scanner = getImaxScannerService(interaction.client);

        // Login doesn't need the scanner
        if (subcommand === 'login') {
            return handleLogin(interaction);
        }
        if (subcommand === 'logout') {
            return handleLogout(interaction);
        }

        if (!scanner) {
            return replyWith(interaction, {
                content: 'IMAX Scanner service is not available.',
                ephemeral: true,
            });
        }

        try {
            switch (subcommand) {
                case 'scan':
                    await handleScan(interaction, scanner);
                    break;
                case 'sessions':
                    await handleSessions(interaction, scanner);
                    break;
                case 'check':
                    await handleCheck(interaction, scanner);
                    break;
                case 'book':
                    await handleBook(interaction, scanner);
                    break;
                default:
                    await replyWith(interaction, {
                        content: 'Unknown subcommand.',
                        ephemeral: true,
                    });
            }
        } catch (error) {
            logger.error('Movie command error', { error: error.message, subcommand });

            const errorMessage = `An error occurred: ${error.message}`;

            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: errorMessage });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    },

    // Handle modal submission for login
    async handleModalSubmit(interaction) {
        if (interaction.customId !== 'imax_login_modal') return false;

        const email = interaction.fields.getTextInputValue('imax_email');
        const password = interaction.fields.getTextInputValue('imax_password');

        try {
            await storeCredentials(interaction.user.id, email, password);

            await interaction.reply({
                content: '✅ Big League credentials saved securely. You can now use `/movie book` for auto-checkout.',
                ephemeral: true,
            });

            logger.info('User stored IMAX credentials', {
                userId: interaction.user.id,
                email: email.replace(/(.{2}).*@/, '$1***@'),
            });

        } catch (error) {
            logger.error('Failed to store credentials', { error: error.message });
            await interaction.reply({
                content: `❌ Failed to save credentials: ${error.message}`,
                ephemeral: true,
            });
        }

        return true;
    },
};

/**
 * Handle /movie scan command
 */
async function handleScan(interaction, scanner) {
    const movieInput = interaction.options.getString('movie');
    const numSeats = interaction.options.getInteger('seats') || 2;

    if (!movieInput) {
        return replyWith(interaction, {
            content: 'Please provide a valid IMAX movie URL or ID.',
            ephemeral: true,
        });
    }

    logger.info('Starting IMAX scan from command', {
        userId: interaction.user.id,
        movieInput,
        numSeats,
    });

    // Send initial status
    await replyWith(interaction, {
        content: `🔍 Scanning IMAX sessions for optimal seats...\nThis may take a minute.`,
    });

    // Track last progress update to avoid rate limits
    let lastProgressUpdate = 0;
    const PROGRESS_UPDATE_INTERVAL = 3000; // Update at most every 3 seconds

    try {
        const results = await scanner.scanMovie(movieInput, numSeats, {
            onProgress: async (progress) => {
                const now = Date.now();
                // Only update if enough time has passed (avoid Discord rate limits)
                if (now - lastProgressUpdate >= PROGRESS_UPDATE_INTERVAL) {
                    lastProgressUpdate = now;
                    const optimalIcon = progress.optimalFound > 0 ? '🎯' : '🔍';
                    await interaction.editReply({
                        content: `${optimalIcon} Scanning sessions... **${progress.scanned}/${progress.total}** (${progress.percent}%)\n` +
                            `Found **${progress.optimalFound}** with optimal seating so far.`,
                    }).catch(() => {}); // Ignore edit errors
                }
            },
        });

        // Format and send results
        const embed = scanner.formatResultsEmbed(results);

        await replyWith(interaction, {
            content: '',
            embeds: [embed],
        });

        logger.info('IMAX scan complete', {
            userId: interaction.user.id,
            movieInput,
            sessionsScanned: results.summary?.sessionsScanned || results.sessions?.length || 0,
            sessionsWithOptimal: results.summary?.sessionsWithOptimal || 0,
        });

    } catch (error) {
        logger.error('IMAX scan failed', { error: error.message });
        await replyWith(interaction, {
            content: `❌ Scan failed: ${error.message}`,
        });
    }
}

/**
 * Handle /movie sessions command
 */
async function handleSessions(interaction, scanner) {
    const dateInput = interaction.options.getString('date');

    const date = parseDate(dateInput);
    if (!date) {
        return replyWith(interaction, {
            content: `Invalid date format: "${dateInput}". Use today, tomorrow, YYYY-MM-DD, or DD/MM/YYYY.`,
            ephemeral: true,
        });
    }

    try {
        const sessions = await scanner.getSessions(date);
        const embed = scanner.formatSessionsEmbed(sessions, date);

        await replyWith(interaction, {
            embeds: [embed],
        });

    } catch (error) {
        logger.error('Failed to get sessions', { error: error.message });
        await replyWith(interaction, {
            content: `Failed to fetch sessions: ${error.message}`,
        });
    }
}

/**
 * Handle /movie check command
 */
async function handleCheck(interaction, scanner) {
    const sessionId = interaction.options.getString('session_id');
    const numSeats = interaction.options.getInteger('seats') || 2;

    // Extract session ID if a full URL was provided
    let parsedSessionId = sessionId;
    const urlMatch = sessionId.match(/(?:txtSessionId|tnpSessionId)=(\d+)/);
    if (urlMatch) {
        parsedSessionId = urlMatch[1];
    }

    if (!/^\d+$/.test(parsedSessionId)) {
        return replyWith(interaction, {
            content: 'Invalid session ID. Please provide a numeric session ID or a booking URL.',
            ephemeral: true,
        });
    }

    logger.info('Checking IMAX session', {
        userId: interaction.user.id,
        sessionId: parsedSessionId,
        numSeats,
    });

    try {
        const result = await scanner.scanSession(parsedSessionId, numSeats);

        const sessionInfo = {
            movie: 'Unknown',
            time: 'Unknown',
            url: `https://ticketing.imaxmelbourne.com.au/Ticketing/visSelectTickets.aspx?txtSessionId=${parsedSessionId}`,
        };

        const embed = scanner.formatSessionEmbed(result, sessionInfo);

        await replyWith(interaction, {
            embeds: [embed],
        });

    } catch (error) {
        logger.error('Session check failed', { error: error.message });
        await replyWith(interaction, {
            content: `Failed to check session: ${error.message}`,
        });
    }
}

/**
 * Handle /movie login command
 */
async function handleLogin(interaction) {
    // Show a modal to collect credentials
    const modal = new ModalBuilder()
        .setCustomId('imax_login_modal')
        .setTitle('Big League Login');

    const emailInput = new TextInputBuilder()
        .setCustomId('imax_email')
        .setLabel('Big League Email')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('your@email.com')
        .setRequired(true);

    const passwordInput = new TextInputBuilder()
        .setCustomId('imax_password')
        .setLabel('Big League Password')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Your password')
        .setRequired(true);

    const emailRow = new ActionRowBuilder().addComponents(emailInput);
    const passwordRow = new ActionRowBuilder().addComponents(passwordInput);

    modal.addComponents(emailRow, passwordRow);

    await interaction.showModal(modal);
}

/**
 * Handle /movie logout command
 */
async function handleLogout(interaction) {
    const userId = interaction.user.id;

    const hasCreds = await hasCredentials(userId);

    if (!hasCreds) {
        return interaction.reply({
            content: 'You don\'t have any stored Big League credentials.',
            ephemeral: true,
        });
    }

    try {
        await deleteCredentials(userId);

        await interaction.reply({
            content: '✅ Your Big League credentials have been deleted.',
            ephemeral: true,
        });

        logger.info('User deleted IMAX credentials', { userId });

    } catch (error) {
        logger.error('Failed to delete credentials', { error: error.message });
        await interaction.reply({
            content: `❌ Failed to delete credentials: ${error.message}`,
            ephemeral: true,
        });
    }
}

/**
 * Handle /movie book command - scan and auto-checkout
 */
async function handleBook(interaction, scanner) {
    const movieInput = interaction.options.getString('movie');
    const numSeats = interaction.options.getInteger('seats') || 2;
    const userId = interaction.user.id;

    // Check if user has credentials
    const hasCreds = await hasCredentials(userId);
    if (!hasCreds) {
        return replyWith(interaction, {
            content: '❌ No Big League credentials stored. Use `/movie login` first to set up auto-checkout.',
            ephemeral: true,
        });
    }

    logger.info('Starting auto-book', { userId, movieInput, numSeats });

    await replyWith(interaction, {
        content: `🔍 Scanning sessions for optimal seats...\nThis may take a minute.`,
    });

    // Track last progress update to avoid rate limits
    let lastProgressUpdate = 0;
    const PROGRESS_UPDATE_INTERVAL = 3000;

    try {
        // First, scan for optimal seats with progress updates
        const results = await scanner.scanMovie(movieInput, numSeats, {
            onProgress: async (progress) => {
                const now = Date.now();
                if (now - lastProgressUpdate >= PROGRESS_UPDATE_INTERVAL) {
                    lastProgressUpdate = now;
                    const optimalIcon = progress.optimalFound > 0 ? '🎯' : '🔍';
                    await interaction.editReply({
                        content: `${optimalIcon} Scanning sessions... **${progress.scanned}/${progress.total}** (${progress.percent}%)\n` +
                            `Found **${progress.optimalFound}** with optimal seating so far.`,
                    }).catch(() => {});
                }
            },
        });

        if (!results.sessions || results.sessions.length === 0) {
            const embed = scanner.formatResultsEmbed(results);
            return await replyWith(interaction, {
                content: '❌ No sessions with optimal seating found.',
                embeds: [embed],
            });
        }

        // Find the best session (first one with optimal seats)
        const bestSession = results.sessions.find(s => s.hasOptimal && s.optimalGroups?.length > 0);

        if (!bestSession) {
            const embed = scanner.formatResultsEmbed(results);
            return await replyWith(interaction, {
                content: '❌ Found sessions but none have optimal seating available.',
                embeds: [embed],
            });
        }

        // Get the best seat group
        const bestGroup = bestSession.optimalGroups[0];

        await interaction.editReply({
            content: `🎯 Found optimal seats! **Row ${bestGroup.row}** (${bestGroup.seatCount} seats, center score: ${bestGroup.centerScore})\n\n🔐 Logging in and pre-filling checkout...`,
        });

        // Prefill checkout with the best seats
        const checkoutResult = await prefillCheckout({
            userId,
            sessionId: bestSession.sessionId,
            sessionUrl: bestSession.url,
            numSeats,
            preferredSeats: bestGroup.seats,
            movieTitle: bestSession.movie || results.movieTitle,
            sessionDate: bestSession.date,
            sessionTime: bestSession.time,
        });

        if (checkoutResult.success) {
            const embed = new EmbedBuilder()
                .setTitle('🎟️ Checkout Ready!')
                .setColor(0x00ff00)
                .setDescription(
                    `**Movie:** ${bestSession.movie || results.movieTitle}\n` +
                    `**Session:** ${bestSession.date ? new Date(bestSession.date).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' : ''}${bestSession.time}\n` +
                    `**Seats:** Row ${bestGroup.row} (${bestGroup.seatCount} seats)\n` +
                    `**Center Score:** ${Math.round(bestGroup.centerScore * 100)}%`
                )
                .addFields({
                    name: '🔗 Complete Your Purchase',
                    value: `[Click here to complete checkout](${checkoutResult.checkoutUrl})\n\nSeats are selected and ready - just confirm and pay!`,
                })
                .setFooter({ text: 'Seats may timeout after ~10 minutes' })
                .setTimestamp();

            await interaction.editReply({
                content: '',
                embeds: [embed],
            });

        } else {
            // Checkout prefill failed, provide manual link
            const embed = scanner.formatResultsEmbed(results);
            embed.addFields({
                name: '⚠️ Auto-checkout failed',
                value: `${checkoutResult.error}\n\n[Book manually](${bestSession.url})`,
            });

            await interaction.editReply({
                content: '',
                embeds: [embed],
            });
        }

    } catch (error) {
        logger.error('Auto-book failed', { error: error.message });
        await replyWith(interaction, {
            content: `❌ Auto-book failed: ${error.message}`,
        });
    }
}
