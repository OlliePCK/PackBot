const guild = require('../models/guildSchema');
const mongoose = require('mongoose');

module.exports = {
	name: 'interactionCreate',
	async execute(interaction) {
		if (!interaction.isCommand()) return;

		const command = interaction.client.commands.get(interaction.commandName);

		if (!command) return;

		try {
			if (command.isEphemeral) {
				await interaction.deferReply({ ephemeral: true }); // Add this line to defer the reply
    			await command.execute(interaction);
			}
    		else {
				await interaction.deferReply(); // Add this line to defer the reply
    			await command.execute(interaction);
			}
		}
		catch (error) {
    		console.log(error);
    		await interaction.editReply({ content: 'There was an error while executing this command!', ephemeral: true });
		}

		let guildProfile = await guild.findOne({ guildId: interaction.guildId });
		if (!guildProfile) {
			guildProfile = await new guild({
				_id: new mongoose.Types.ObjectId(),
				guildId: interaction.guildId,
			});
			await guildProfile.save().catch(err => console.log(err));
		}
	},
};
