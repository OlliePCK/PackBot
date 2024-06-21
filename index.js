const fs = require('fs');
const { Client, Collection, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config();
const config = require('./config.json');

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
const { DisTube } = require('distube');
const { SoundCloudPlugin } = require('@distube/soundcloud');
const { SpotifyPlugin } = require('@distube/spotify');
const { YouTubePlugin } = require('@distube/youtube');
const { FilePlugin } = require('@distube/file');
const { DirectLinkPlugin } = require('@distube/direct-link');

client.distube = new DisTube(client, {
	plugins: [
		new YouTubePlugin(),
		new SoundCloudPlugin(),
		new SpotifyPlugin(),
		new DirectLinkPlugin(),
		new FilePlugin(),
	],
	emitAddListWhenCreatingQueue: true,
	emitAddSongWhenCreatingQueue: true,
});

client.commands = new Collection();
client.monitoringTasks = new Collection();
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
const eventFiles = fs.readdirSync('./events/client').filter(file => file.endsWith('.js'));

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
				{ name: 'Loop', value: `${queue.repeatMode ? queue.repeatMode === 2 ? `${client.emotes.repeat} All Queue` : `${client.emotes.repeat} This Song` : 'Off'}`, inline: true },
				{ name: 'Autoplay', value: `${queue.autoplay ? `${client.emotes.autoplay} On` : 'Off'}`, inline: true },
			)
			.setImage(`${song.thumbnail}`)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('pause', queue => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.pause} | Music paused!`)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('stop', queue => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.stop} | Music stopped!`)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('skip', queue => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.skip} | Skipped: ${queue.previousSongs[0].name}`)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('repeatModeChange', (queue, repeatMode) => {
		const embed = new EmbedBuilder()
			.setTitle(`${repeatMode === 2 ? `${client.emotes.repeat} All Queue` : repeatMode === 1 ? `${client.emotes.repeat} This Song` : 'Off'} | Loop mode changed!`)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('shuffle', queue => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.shuffle} | Queue shuffled!`)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('filterAdd', (queue, filter) => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.filter} | Added Filter: \`${filter}\``)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('filterRemove', (queue, filter) => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.filter} | Removed Filter: \`${filter}\``)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('volumeChange', (queue, volume) => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.volume} | Volume changed: \`${volume}%\``)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('autoplayOn', queue => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.autoplay} | Autoplay enabled!`)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('autoplayOff', queue => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.autoplay} | Autoplay disabled!`)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('volumeNaturallyChanged', (queue, volume) => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.volume} | Volume changed to: \`${volume}%\``)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		queue.textChannel.send({ embeds: [embed] });
	})
	.on('searchResult', (message, result) => {
		let i = 0;
		const embed = new EmbedBuilder()
			.setTitle(`🔎 | Results for: \`${result.query}\``)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		result.items.forEach(song => {
			i++;
			if (i > 5) return;
			embed.addField(`${i}. ${song.name}`, `[Link](${song.url}) - \`${song.formattedDuration}\``);
		});
		message.channel.send({ embeds: [embed] });
	})
	.on('searchCancel', message => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.error} | Search Cancelled`)
			.setDescription('The search has been cancelled. Please try again.')
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		message.channel.send({ embeds: [embed] });
	})
	.on('error', (channel, error) => {
		const embed = new EmbedBuilder()
			.setTitle(`${client.emotes.error} | Error occurred!`)
			.setDescription(`An error occurred while executing the command: ${error}`)
			.setFooter({
				text: 'The Pack',
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
		channel.send({ embeds: [embed] });
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
	.on('addSong', (queue, song) => {
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
				iconURL: 'https://i.imgur.com/5RpRCEY.jpeg'
			})
			.setColor('#ff006a');
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
	});


client.login(process.env.TOKEN);
