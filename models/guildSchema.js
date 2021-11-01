const mongoose = require('mongoose');

const guildSchema = new mongoose.Schema({
	_id: mongoose.Schema.Types.ObjectId,
	guildId: String,
	liveRoleID: { type: String, required: false },
	liveChannelID: { type: String, required: false },
	generalChannelID: { type: String, required: false },
});

module.exports = new mongoose.model('Guild', guildSchema, 'guilds');