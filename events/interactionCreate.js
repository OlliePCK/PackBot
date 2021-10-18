module.exports = {
	name: 'interactionCreate',
	async execute(interaction) {
		if (!interaction.isCommand()) return;

		const command = interaction.client.commands.get(interaction.commandName);

		if (!command) return;

		await interaction.deferReply();

		try {
			await command.execute(interaction);
		}
		catch (error) {
			console.log(error);
			await interaction.editReply({ content: 'There was an error while executing this command!', ephemeral: true });
		}
	},
};