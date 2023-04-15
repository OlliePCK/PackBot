const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('purge')
		.setDescription('Mass deletes messages (max 100)')
		.addIntegerOption(option => option.setName('amount').setDescription('The amount of messages to delete').setRequired(true)),
	async execute(interaction) {
		const amount = interaction.options.getInteger('amount');
		if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
			return interaction.editReply('You aren\'t an admin');
		}
		if (isNaN(amount)) {
			return interaction.editReply('That isn\'t a valid number!');
		}
		else if (amount < 1 || amount > 100) {
			return interaction.editReply('You tryna nuke us? Can only purge max 100 messages at a time!');
		}

		interaction.channel.bulkDelete(amount, true).catch(err => {
			console.error(err);
			interaction.editReply('Try again!');
			return;
		});
	},
};