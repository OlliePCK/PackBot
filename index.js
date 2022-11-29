const fs = require('fs');
const { Client, Collection, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config();
const config = require('./config.json');
const mongoose = require('mongoose');

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildPresences,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildVoiceStates,
	],
});

// test

const cookie = process.env.COOKIE;
const IDtoken = process.env.IDTOKEN;

client.emotes = config.emoji;
const DisTube = require('distube');
const { default: SoundCloudPlugin } = require('@distube/soundcloud');
const { default: SpotifyPlugin } = require('@distube/spotify');
const { YtDlpPlugin } = require('@distube/yt-dlp');
client.distube = new DisTube.DisTube(client, {
	searchSongs: 10,
	emitNewSongOnly: true,
	nsfw: true,
	youtubeCookie: cookie,
	leaveOnStop: false,
	savePreviousSongs: true,
	youtubeIdentityToken: IDtoken,
	customFilters: {
		'clear': 'dynaudnorm=f=200',
		'lowbass': 'bass=g=6,dynaudnorm=f=200',
		'8D': 'apulsator=hz=0.08',
	},
	plugins: [new SoundCloudPlugin(), new YtDlpPlugin({ update: true }), new SpotifyPlugin({
		parallel: true,
		emitEventsAfterFetching: true,
		api: {
			clientId: process.env.CLIENTID,
			clientSecret: process.env.CLIENTSECRET,
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
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.play} | Now playing: ${song.name}`)
			.setURL(`${song.url}`)
			.addFields(
				{ name: 'Duration', value: `\`${song.formattedDuration}\``, inline: true },
				{ name: 'Requested by', value: `${song.user}`, inline: true },
				{ name: 'Volume', value: `\`${queue.volume}%\``, inline: true },
				{ name: 'Filter', value: `\`${queue.filters.names.join(', ') || 'Off'}\``, inline: true },
				{ name: 'Loop', value: `\`${queue.repeatMode ? queue.repeatMode === 2 ? 'All Queue' : 'This Song' : 'Off'}\``, inline: true },
				{ name: 'Autoplay', value: `\`${queue.autoplay ? 'On' : 'Off'}\``, inline: true },
			)
			.setImage(`${song.thumbnail}`)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('addSong', (queue, song) => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.success} | Song added: ${song.name}`)
			.setURL(`${song.url}`)
			.addFields(
				{ name: 'Duration', value: `\`${song.formattedDuration}\``, inline: true },
				{ name: 'Requested by', value: `${song.user}`, inline: true },
				{ name: 'Source', value: `\`${song.source}\``, inline: true },
			)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('addList', (queue, playlist) => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.success} | Playlist added: ${playlist.name}`)
			.setURL(`${playlist.url}`)
			.addFields(
				{ name: 'Songs', value: `\`${playlist.songs.length}\``, inline: true },
				{ name: 'Requested by', value: `${playlist.user}`, inline: true },
				{ name: 'Duration', value: `\`${playlist.formattedDuration}\``, inline: true },
			)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		if (playlist.thumbnail) {
			embed.setImage(`${playlist.thumbnail}`);
		}
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('empty', queue => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.success} | No one listening, leaving the channel!`)
			.setDescription('Thank you for using The Pack music bot.')
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('finish', queue => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.success} | Music finished!`)
			.setDescription('Thank you for using The Pack music bot.')
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	});

client.login(process.env.TOKEN);
