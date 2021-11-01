const fs = require('fs');
const { Client, Collection, Intents, MessageEmbed } = require('discord.js');
require('dotenv').config();
const config = require('./config.json');
const mongoose = require('mongoose');

const client = new Client({
	intents: [
		Intents.FLAGS.GUILDS,
		Intents.FLAGS.GUILD_MESSAGES,
		Intents.FLAGS.GUILD_PRESENCES,
		Intents.FLAGS.GUILD_MEMBERS,
		Intents.FLAGS.GUILD_VOICE_STATES,
	],
});

const cookie = process.env.COOKIE;

client.emotes = config.emoji;
const DisTube = require('distube');
const { default: SoundCloudPlugin } = require('@distube/soundcloud');
const { default: SpotifyPlugin } = require('@distube/spotify');
client.distube = new DisTube.DisTube(client, {
	searchSongs: 10,
	emitNewSongOnly: true,
	nsfw: true,
	youtubeCookie: cookie,
	leaveOnStop: false,
	savePreviousSongs: true,
	youtubeIdentityToken: 'QUFFLUhqbE13SGdoU3pwR19RdHJxcHVXX3BFd2tkMHd1UXw\\u003d',
	customFilters: {
		'clear': 'dynaudnorm=f=200',
		'lowbass': 'bass=g=6,dynaudnorm=f=200',
		'8D': 'apulsator=hz=0.08',
	},
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

mongoose.connect(process.env.MONGODB_SRV).then(() => {
	console.log('Connected to the database!');
}).catch((err) => {
	console.log(err);
});

client.distube
	.on('playSong', (queue, song) => {
		const embed = new MessageEmbed()
			.setTitle(`${client.emotes.play} | Now playing: ${song.name}`)
			.setURL(`${song.url}`)
			.addFields(
				{ name: 'Duration', value: `\`${song.formattedDuration}\``, inline: true },
				{ name: 'Requested by', value: `${song.user}`, inline: true },
				{ name: 'Volume', value: `\`${queue.volume}%\``, inline: true },
				{ name: 'Filter', value: `\`${queue.filters.join(', ') || 'Off'}\``, inline: true },
				{ name: 'Loop', value: `\`${queue.repeatMode ? queue.repeatMode === 2 ? 'All Queue' : 'This Song' : 'Off'}\``, inline: true },
				{ name: 'Autoplay', value: `\`${queue.autoplay ? 'On' : 'Off'}\``, inline: true },
			)
			.setImage(`${song.thumbnail}`)
			.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('addSong', (queue, song) => {
		const embed = new MessageEmbed()
			.setTitle(`${client.emotes.success} | Song added: ${song.name}`)
			.setURL(`${song.url}`)
			.addFields(
				{ name: 'Duration', value: `\`${song.formattedDuration}\``, inline: true },
				{ name: 'Requested by', value: `${song.user}`, inline: true },
				{ name: 'Source', value: `\`${song.source}\``, inline: true },
			)
			.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('addList', (queue, playlist) => {
		const embed = new MessageEmbed()
			.setTitle(`${client.emotes.success} | Playlist added: ${playlist.name}`)
			.setURL(`${playlist.url}`)
			.addFields(
				{ name: 'Songs', value: `\`${playlist.songs.length}\``, inline: true },
				{ name: 'Requested by', value: `${playlist.user}`, inline: true },
				{ name: 'Duration', value: `\`${playlist.formattedDuration}\``, inline: true },
			)
			.setFooter('The Pack', 'https://i.imgur.com/5RpRCEY.jpeg')
			.setColor('#ff006a');
		if (playlist.thumbnail) {
			embed.setImage(`${playlist.thumbnail}`);
		}
		queue.textChannel.send({ embeds: [embed] });
	})
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
