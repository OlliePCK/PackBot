const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios'); // For HTTP requests

module.exports = {
    data: new SlashCommandBuilder()
        .setName('monitor')
        .setDescription('Monitor a webpage for updates')
        .addStringOption(option => option.setName('action').setDescription('Start, stop, or list the monitoring tasks').setRequired(true)
            .addChoices(
                { name: 'start', value: 'start' },
                { name: 'stop', value: 'stop' },
                { name: 'list', value: 'list' }
            ))
        .addStringOption(option => option.setName('url').setDescription('A link to any webpage'))
        .addStringOption(option => option.setName('search').setDescription('The text you want to monitor on the page'))
        .addStringOption(option => option.setName('id').setDescription('ID of the monitoring task')),
    async execute(interaction) {
        let url = interaction.options.getString('url');
        let query = interaction.options.getString('search');
        let action = interaction.options.getString('action');
        let id = interaction.options.getString('id');
        let guildID = interaction.guild.id;


        // Initialize the guild's task map if it doesn't exist
        if (!interaction.client.monitoringTasks.has(guildID)) {
            interaction.client.monitoringTasks.set(guildID, new Map());
        }
        let guildTasks = interaction.client.monitoringTasks.get(guildID);

        if (action === 'start') {
            if (!url || !query) {
                return interaction.editReply({ content: 'Please specify both a URL and a search query.', ephemeral: true });
            }

            let intervalId = setInterval(async () => {
                try {
                    const response = await axios.get(url);
                    if (response.status === 200) {
                        if (response.data.includes(query)) {
                            const embed = new EmbedBuilder()
                                .setURL(url)
                                .setTitle(`${interaction.client.emotes.search} | Pack Monitor`)
                                .setColor('#ff006a')
                                .setDescription(`${interaction.user}, The text "${query}" was found!`)
                            return interaction.channel.send({ embeds: [embed] });
                        }
                    } else {
                        console.error(`There was a problem accessing the page at ${url}.`);
                    }
                } catch (error) {
                    console.error(error);
                }
            }, 60000);  // Run every 60 seconds

            // Save the intervalId with a unique task id
            const taskId = Date.now().toString();
            guildTasks.set(taskId, { intervalId, channel: interaction.channel, url });


            return interaction.editReply(`Started monitoring. Your task ID is ${taskId}`);

        } else if (action === 'stop') {
            if (!id) {
                return interaction.editReply({ content: 'Please specify a task ID.', ephemeral: true });
            }

            let task = guildTasks.get(id);
            if (task) {
                clearInterval(task.intervalId);
                guildTasks.delete(id);
                return interaction.editReply(`Stopped monitoring task with ID ${id}`);
            } else {
                return interaction.editReply({ content: 'Could not find a monitoring task with that ID.', ephemeral: true });
            }

        }
        else if (action === 'list') {
            if (guildTasks.size === 0) {
                return interaction.editReply({ content: 'No monitoring tasks in this guild.', ephemeral: true });
            }

            let taskList = '';
            for (let [id, task] of guildTasks) {
                taskList += `Task ID: [${id}](${task.url})\n`;
            }

            return interaction.editReply(`Current monitoring tasks:\n${taskList}`);
        }

    }
}