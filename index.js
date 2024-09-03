const fs = require('fs');
const { Client, Collection, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const config = require('./config.json');
require('dotenv').config();

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildPresences,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildVoiceStates,
	],
});

client.emotes = config.emoji;
client.logo = config.logo;
const { DisTube } = require('distube');
const { SoundCloudPlugin } = require('@distube/soundcloud');
const { SpotifyPlugin } = require('@distube/spotify');
const { YouTubePlugin } = require('@distube/youtube');
const { FilePlugin } = require('@distube/file');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const { DirectLinkPlugin } = require('@distube/direct-link');

client.distube = new DisTube(client, {
	plugins: [
		new YouTubePlugin({ cookies: JSON.parse(fs.readFileSync("cookies.json")) }),
		/*new SoundCloudPlugin({
			clientId: process.env.SOUNDCLOUD_CLIENT_ID,
			oauthToken: process.env.SOUNDCLOUD_OAUTH_TOKEN,
		  }),*/
		new SoundCloudPlugin(),
		new SpotifyPlugin({
			api: {
				clientId: process.env.SPOTIFY_CLIENT_ID,
				clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
				topTracksCountry: "US",
			},
		}),
		new DirectLinkPlugin(),
		new FilePlugin(),
		new YtDlpPlugin({ update: true }),
	],
	emitAddListWhenCreatingQueue: true,
	emitAddSongWhenCreatingQueue: true,
});

client.commands = new Collection();
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
const eventFiles = fs.readdirSync('./events/client').filter(file => file.endsWith('.js'));
const eventFunctions = fs.readdirSync('./events/event-functions').filter(file => file.endsWith('.js'));


for (const file of commandFiles) {
	const command = require(`./commands/${file}`);
	// Set a new item in the Collection
	// With the key as the command name and the value as the exported module
	client.commands.set(command.data.name, command);
}

for (const file of eventFiles) {
	const event = require(`./events/client/${file}`);
	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args));
	}
	else {
		client.on(event.name, (...args) => event.execute(...args));
	}
}

for (const file of eventFunctions) {
	const event = require(`./events/event-functions/${file}`);
	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args));
	}
	else {
		client.on(event.name, (...args) => event.execute(...args));
	}
}

client.distube
	.on('playSong', (queue, song) => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.play} | Now playing: ${song.name}`)
				.setURL(`${song.url}`)
				.addFields(
					{ name: 'Duration', value: `\`${song.formattedDuration}\``, inline: true },
					{ name: 'Requested by', value: `${song.user}`, inline: true },
					{ name: 'Volume', value: `\`${queue.volume}%\``, inline: true },
					{ name: 'Filter', value: `\`${queue.filters.names.join(', ') || 'Off'}\``, inline: true },
					{ name: 'Loop', value: `${queue.repeatMode ? queue.repeatMode === 2 ? `${client.emotes.repeat} All Queue` : `${client.emotes.repeat} This Song` : 'Off'}`, inline: true },
					{ name: 'Autoplay', value: `${queue.autoplay ? `${client.emotes.autoplay} On` : 'Off'}`, inline: true },
				)
				.setImage(`${song.thumbnail}`)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('pause', queue => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.pause} | Music paused!`)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('stop', queue => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.stop} | Music stopped!`)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('skip', queue => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.skip} | Skipped: ${queue.previousSongs[0].name}`)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('repeatModeChange', (queue, repeatMode) => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${repeatMode === 2 ? `${client.emotes.repeat} All Queue` : repeatMode === 1 ? `${client.emotes.repeat} This Song` : 'Off'} | Loop mode changed!`)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('shuffle', queue => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.shuffle} | Queue shuffled!`)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('filterAdd', (queue, filter) => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.filter} | Added Filter: \`${filter}\``)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('filterRemove', (queue, filter) => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.filter} | Removed Filter: \`${filter}\``)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('volumeChange', (queue, volume) => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.volume} | Volume changed: \`${volume}%\``)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('autoplayOn', queue => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.autoplay} | Autoplay enabled!`)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('autoplayOff', queue => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.autoplay} | Autoplay disabled!`)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('volumeNaturallyChanged', (queue, volume) => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.volume} | Volume changed to: \`${volume}%\``)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('searchResult', (message, result) => {
		try {
			let i = 0;
			const embed = new EmbedBuilder()
				.setTitle(`🔎 | Results for: \`${result.query}\``)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			result.items.forEach(song => {
				i++;
				if (i > 5) return;
				embed.addField(`${i}. ${song.name}`, `[Link](${song.url}) - \`${song.formattedDuration}\``);
			});
			message.channel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('searchCancel', message => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.error} | Search Cancelled`)
				.setDescription('The search has been cancelled. Please try again.')
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			message.channel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('error', (error, queue) => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.error} | Error occurred!`)
				.setDescription(`An error occurred! ${error}`)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('finish', queue => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.success} | Music finished!`)
				.setDescription('Thank you for using The Pack music bot.')
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('addList', (queue, playlist) => {
		try {
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
					iconURL: client.logo
				})
				.setColor('#ff006a');
			if (playlist.thumbnail) {
				embed.setImage(`${playlist.thumbnail}`);
			}
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	.on('addSong', (queue, song) => {
		try {
			const embed = new EmbedBuilder()
				.setTitle(`${client.emotes.success} | Song added: ${song.name}`)
				.setURL(`${song.url}`)
				.addFields(
					{ name: 'Duration', value: `\`${song.formattedDuration}\``, inline: true },
					{ name: 'Requested by', value: `${song.user}`, inline: true },
					{ name: 'Position in queue', value: `${queue.songs.length}`, inline: true },
				)
				.setThumbnail(song.thumbnail)
				.setFooter({
					text: 'The Pack',
					iconURL: client.logo
				})
				.setColor('#ff006a');
			queue.textChannel.send({ embeds: [embed] });
		} catch (error) {
			console.error(error);
		}
	})
	//.on('debug', console.log);
	.on('ffmpegDebug', console.log)

client.login(process.env.TOKEN);
