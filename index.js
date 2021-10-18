const fs = require('fs');
const { Client, Collection, Intents } = require('discord.js');
require('dotenv').config();
const config = require('./config.json');

const client = new Client({
	intents: [
		Intents.FLAGS.GUILDS,
		Intents.FLAGS.GUILD_MESSAGES,
		Intents.FLAGS.GUILD_PRESENCES,
		Intents.FLAGS.GUILD_MEMBERS,
		Intents.FLAGS.GUILD_VOICE_STATES,
	],
});

client.emotes = config.emoji;
const DisTube = require('distube');
const { default: SoundCloudPlugin } = require('@distube/soundcloud');
const { default: SpotifyPlugin } = require('@distube/spotify');
client.distube = new DisTube.DisTube(client, {
	searchSongs: 10,
	emitNewSongOnly: true,
	plugins: [new SoundCloudPlugin(), new SpotifyPlugin({
		parallel: true,
		emitEventsAfterFetching: true,
		api: {
			clientId: 'a89d775136c3427b91179300236b7ae9',
			clientSecret: 'bb53191555f846f7bd3291a6ece7ea49',
		},
	})],
});

client.commands = new Collection();
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
const eventFiles = fs.readdirSync('./events').filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
	const command = require(`./commands/${file}`);
	// Set a new item in the Collection
	// With the key as the command name and the value as the exported module
	client.commands.set(command.data.name, command);
}

for (const file of eventFiles) {
	const event = require(`./events/${file}`);
	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args));
	}
	else {
		client.on(event.name, (...args) => event.execute(...args));
	}
}

const status = queue => `Volume: \`${queue.volume}%\` | Filter: \`${queue.filters.join(', ') || 'Off'}\` | Loop: \`${queue.repeatMode ? queue.repeatMode === 2 ? 'All Queue' : 'This Song' : 'Off'}\` | Autoplay: \`${queue.autoplay ? 'On' : 'Off'}\``;
client.distube
	.on('playSong', (queue, song) => queue.textChannel.send(
		`${client.emotes.play} | Playing \`${song.name}\` - \`${song.formattedDuration}\`\nRequested by: ${song.user}\n${status(queue)}`,
	))
	.on('addSong', (queue, song) => queue.textChannel.send(
		`${client.emotes.success} | Added ${song.name} - \`${song.formattedDuration}\` to the queue by ${song.user}`,
	))
	.on('addList', (queue, playlist) => queue.textChannel.send(
		`${client.emotes.success} | Added \`${playlist.name}\` playlist (${playlist.songs.length} songs) to queue\n${status(queue)}`,
	))
// DisTubeOptions.searchSongs = true
	.on('searchResult', (interaction, result) => {
		let i = 0;
		interaction.channel.send(`**Choose an option from below**\n${result.map(song => `**${++i}**. ${song.name} - \`${song.formattedDuration}\``).join('\n')}\n*Enter anything else or wait 60 seconds to cancel*`);
	})
// DisTubeOptions.searchSongs = true
	.on('searchCancel', interaction => interaction.channel.send(`${client.emotes.error} | Searching canceled`))
	.on('error', (channel, e) => {
		channel.send(`${client.emotes.error} | An error encountered: ${e}`);
		console.error(e);
	})
	.on('empty', channel => channel.send('Voice channel is empty! Leaving the channel...'))
	.on('searchNoResult', interaction => interaction.channel.send(`${client.emotes.error} | No result found!`))
	.on('finish', queue => queue.textChannel.send('Finished!'));

client.login(process.env.TOKEN);
