const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const logger = require('../logger');

// Reference to the MUSIC_CORRECTIONS object in play.js
// We'll use a shared state module approach
const trollState = require('../music/trollState');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('troll')
        .setDescription('Manage the Music Taste Correction System™')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub =>
            sub.setName('toggle')
                .setDescription('Toggle the system on/off')
        )
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('View current troll status')
        )
        .addSubcommand(sub =>
            sub.setName('set')
                .setDescription('Set replacement song for a user')
                .addUserOption(opt =>
                    opt.setName('user')
                        .setDescription('The user to troll')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt.setName('url')
                        .setDescription('YouTube URL to replace their songs with')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a user from the troll list')
                .addUserOption(opt =>
                    opt.setName('user')
                        .setDescription('The user to remove')
                        .setRequired(true)
                )
        ),

    // This command is only for the private server
    guildOnly: '773732791585865769',

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'toggle') {
            trollState.enabled = !trollState.enabled;
            const status = trollState.enabled ? '✅ Enabled' : '❌ Disabled';
            
            logger.info(`Music Taste Correction System toggled: ${trollState.enabled}`, { by: interaction.user.tag });
            
            const embed = new EmbedBuilder()
                .setTitle('🎵 Music Taste Correction System™')
                .setDescription(`System is now **${status}**`)
                .setColor(trollState.enabled ? '#00ff00' : '#ff0000')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            
            return interaction.editReply({ embeds: [embed] });
        }

        if (sub === 'status') {
            const users = Object.entries(trollState.users);
            const userList = users.length > 0 
                ? users.map(([id, cfg]) => `<@${id}>: \`${cfg.replacement || 'Random'}\``).join('\n')
                : 'No users configured';

            const embed = new EmbedBuilder()
                .setTitle('🎵 Music Taste Correction System™ Status')
                .addFields(
                    { name: 'System', value: trollState.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
                    { name: 'Targets', value: `${users.length} user(s)`, inline: true },
                    { name: 'User List', value: userList }
                )
                .setColor('#ff006a')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            
            return interaction.editReply({ embeds: [embed] });
        }

        if (sub === 'set') {
            const user = interaction.options.getUser('user');
            const url = interaction.options.getString('url');

            trollState.users[user.id] = { replacement: url };
            
            logger.info(`Added user to troll list`, { userId: user.id, url, by: interaction.user.tag });

            const embed = new EmbedBuilder()
                .setTitle('🎵 User Added to Correction List')
                .setDescription(`${user} will now hear a different song`)
                .addFields({ name: 'Replacement', value: url })
                .setColor('#00ff00')
                .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
            
            return interaction.editReply({ embeds: [embed] });
        }

        if (sub === 'remove') {
            const user = interaction.options.getUser('user');

            if (trollState.users[user.id]) {
                delete trollState.users[user.id];
                logger.info(`Removed user from troll list`, { userId: user.id, by: interaction.user.tag });

                const embed = new EmbedBuilder()
                    .setTitle('🎵 User Removed')
                    .setDescription(`${user} has been removed from the correction list`)
                    .setColor('#ff0000')
                    .setFooter({ text: 'The Pack', iconURL: interaction.client.logo });
                
                return interaction.editReply({ embeds: [embed] });
            } else {
                return interaction.editReply('❌ User is not in the troll list.');
            }
        }
    }
};
