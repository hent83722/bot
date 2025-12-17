require('dotenv').config();
const { runPythonDocker } = require('./dockerpython');
const fetch = global.fetch;
let lastPresenceOnline = null;
let lastPresenceCount = null;
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { Rcon } = require('rcon-client');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Tail } = require('tail');
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN is NOT set. Slash commands cannot register.');
}
const ACTIVITY_CHANNEL_ID = '1449943733758984192'; 
const LINKED_ACCOUNTS_PATH = path.join(__dirname, 'linkedAccounts.json');
const CHAT_CHANNEL_ID = '1449943766357246143'; 
const STATUS_CHANNEL_ID = '1449948050310299718'; 
const STATUS_UPDATE_INTERVAL_MS = 10000; 
const STATUS_THUMBNAIL_URL = 'https://media.discordapp.net/attachments/1400886724044783737/1435622515480203274/tuxx.png?ex=69400da8&is=693ebc28&hm=7a9f101dd181fbaf005f8ff2e72c492e5af2a58f1b4bade713774f3c425b0bfc&=&format=webp&quality=lossless';
const WHITELIST_PATH = path.join(__dirname, '..', 'whitelist.json');
const LOG_PATH = path.join(__dirname, '..', 'logs', 'latest.log');
const SERVER_DIR = path.join(__dirname, '..');
const SERVER_JAR = 'paper.jar';
const SERVER_START_ARGS = ['-jar', SERVER_JAR, '--nogui'];
const ALLOWED_ROLE_IDS = [
  '1449620430569734318',
  '1400860508705394759',
  '1401601054621040701',
  '1400860196364091525',
];
const RCON_ENABLED = process.env.RCON_ENABLED === 'true';
const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = parseInt(process.env.RCON_PORT || '25575', 10);
const RCON_PASSWORD = process.env.RCON_PASSWORD || '';

const PY_PERMS_PATH = './pythonPerms.json';

global.pendingLinks = {};    
global.linkedAccounts = {}; 

const LINK_CODE_EXPIRY_MS = 5 * 60 * 1000;

const chatQueue = [];
let chatSending = false;

function loadLinkedAccounts() {
  try {
    return JSON.parse(fsSync.readFileSync(LINKED_ACCOUNTS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveLinkedAccounts() {
  fsSync.writeFileSync(LINKED_ACCOUNTS_PATH, JSON.stringify(global.linkedAccounts, null, 2));
}
global.linkedAccounts = loadLinkedAccounts();


async function processChatQueue() {
  if (chatSending || chatQueue.length === 0 || !chatChannel) return;

  chatSending = true;
  const msg = chatQueue.shift();

  try {
    await chatChannel.send(msg);
  } catch (err) {
    console.error('Failed to send chat message:', err);
  }

  chatSending = false;
  processChatQueue();
}


function loadPyPerms() {
  try {
    return JSON.parse(fsSync.readFileSync(PY_PERMS_PATH, 'utf8')).allowed || [];
  } catch {
    return [];
  }
}

function savePyPerms(list) {
  fsSync.writeFileSync(
    PY_PERMS_PATH,
    JSON.stringify({ allowed: list }, null, 2)
  );
}

function hasPythonPerm(userId) {
  return loadPyPerms().includes(userId);
}



const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});


let activityChannel = null;
let chatChannel = null;
let statusChannel = null;
let rconClient = null;
let serverProcess = null;
let statusMessageId = null;


async function getRconClient() {
  if (!RCON_ENABLED || !RCON_PASSWORD) {
    return null;
  }
  if (rconClient && rconClient.connected) {
    return rconClient;
  }
  try {
    rconClient = await Rcon.connect({
      host: RCON_HOST,
      port: RCON_PORT,
      password: RCON_PASSWORD,
    });
    rconClient.on('end', () => {
      rconClient = null;
    });
    return rconClient;
  } catch (error) {
    console.error('Failed to connect to RCON:', error);
    rconClient = null;
    return null;
  }
}

async function reloadWhitelist() {
  const client = await getRconClient();
  if (!client) return false;
  try {
    await client.send('whitelist reload');
    return true;
  } catch (error) {
    console.error('Failed to run whitelist reload via RCON:', error);
    return false;
  }
}

async function relayDiscordMessageToMinecraft(username, content) {
  const client = await getRconClient();
  if (!client) {
    return { success: false, message: 'RCON unavailable; cannot relay message to server.' };
  }

  const singleLine = content.replace(/\s+/g, ' ').trim();
  if (!singleLine) return { success: false, message: 'Empty message, nothing to send.' };
  const payload = `say [${username}] ${singleLine}`;
  try {
    await client.send(payload);
    return { success: true };
  } catch (error) {
    console.error('Failed to relay Discord message to Minecraft:', error);
    return { success: false, message: 'Failed to send message to server.' };
  }
}

function isAuthorized(interaction) {

  if (!interaction.guild || !interaction.member || !interaction.member.roles) return false;
  const roles = interaction.member.roles.cache;
  return roles?.some((role) => ALLOWED_ROLE_IDS.includes(role.id)) || false;
}

async function stopServer() {
  const client = await getRconClient();
  if (!client) {
    return { success: false, message: 'RCON unavailable; cannot send stop.' };
  }
  try {
    await client.send('stop');
    return { success: true, message: '🛑 Stop command sent to server.' };
  } catch (error) {
    console.error('Failed to send stop via RCON:', error);
    return { success: false, message: 'Failed to send stop via RCON.' };
  }
}

async function startServer() {

  if (RCON_ENABLED) {
    try {
      const client = await getRconClient();
      if (client) {
        return { success: false, message: 'Server already appears to be running (RCON reachable).' };
      }
    } catch (error) {

    }
  }

  if (serverProcess) {
    return { success: false, message: 'A server start is already in progress.' };
  }

  try {
    const { spawn } = require('child_process');
    serverProcess = spawn('java', SERVER_START_ARGS, {
      cwd: SERVER_DIR,
      stdio: 'inherit',
      detached: false,
    });

    serverProcess.on('exit', () => {
      serverProcess = null;
    });

    return { success: true, message: 'Starting server with paper.jar --nogui...' };
  } catch (error) {
    console.error('Failed to start server process:', error);
    serverProcess = null;
    return { success: false, message: 'Failed to start server process.' };
  }
}

async function getServerStatus() {
  const attemptList = async () => {
    const client = await getRconClient();
    if (!client) return null;
    try {
      return await client.send('list');
    } catch (error) {
      console.error('Failed to fetch status via RCON (attempt):', error);
      try {
        if (rconClient) {
          rconClient.end();
        }
      } catch (e) {

      }
      rconClient = null;
      return null;
    }
  };


  let response = await attemptList();
  if (!response) {
    response = await attemptList();
  }

  if (!response) {
    return { online: false, onlineCount: 0, maxPlayers: 20, players: [] };
  }

  const match = response.match(/There are (\d+) of a max of (\d+) players online: ?(.*)/i);
  let onlineCount = 0;
  let maxPlayers = 20;
  let players = [];

  if (match) {
    onlineCount = parseInt(match[1], 10) || 0;
    maxPlayers = parseInt(match[2], 10) || 20;
    const namesPart = match[3] || '';
    if (namesPart.trim().length > 0) {
      players = namesPart.split(',').map((n) => n.trim()).filter(Boolean);
    }
  } else {

    const parts = response.split(':');
    if (parts.length > 1) {
      const namesPart = parts.slice(1).join(':');
      players = namesPart.split(',').map((n) => n.trim()).filter(Boolean);
      onlineCount = players.length;
    }
  }


  return {
    online: true,
    onlineCount,
    maxPlayers,
    players,
  };
}

function buildStatusEmbed(status) {
  const color = status.online ? 0x2ecc71 : 0xed4245; 
  const playerList = status.players.length > 0
    ? status.players.join('\n')
    : (status.online ? 'No players online.' : 'Server is offline.');

  const embed = new EmbedBuilder()
    .setTitle('Server Status')
    .setColor(color)
    .setThumbnail(STATUS_THUMBNAIL_URL)
    .addFields(
      { name: 'Status', value: status.online ? 'Online' : 'Offline', inline: true },
      { name: 'Players', value: `${status.onlineCount}/${status.maxPlayers}`, inline: true },
    )
    .setTimestamp(new Date());


  if (status.online) {
    embed.addFields({ name: 'Online Players', value: playerList, inline: false });
  }

  return embed;
}

async function getStatusChannel() {
  if (statusChannel) return statusChannel;
  try {
    statusChannel = await client.channels.fetch(STATUS_CHANNEL_ID);
  } catch (error) {
    console.error('Cannot fetch status channel:', error);
    statusChannel = null;
  }
  return statusChannel;
}

async function getOrCreateStatusMessage(embed) {
  const channel = await getStatusChannel();
  if (!channel) return null;

  if (statusMessageId) {
    try {
      const msg = await channel.messages.fetch(statusMessageId);
      await msg.edit({ embeds: [embed] });
      return msg;
    } catch (err) {

      statusMessageId = null;
    }
  }

  try {
    const sent = await channel.send({ embeds: [embed] });
    statusMessageId = sent.id;
    return sent;
  } catch (err) {
    console.error('Failed to send status message:', err);
    return null;
  }
}



async function updateStatusMessageOnce() {
  const status = await getServerStatus();
  const embed = buildStatusEmbed(status);
  const msg = await getOrCreateStatusMessage(embed);


  try {
    let presenceType = status.online ? 'online' : 'dnd';
    let playerCount = status.online ? `${status.onlineCount}/${status.maxPlayers}` : 'offline';

    if (lastPresenceOnline !== status.online || lastPresenceCount !== playerCount) {
      client.user.setPresence({
        status: presenceType,
        activities: [{ name: `Players: ${playerCount}`, type: 3 }],
      });
      lastPresenceOnline = status.online;
      lastPresenceCount = playerCount;
    }
  } catch (err) {
    console.error('Failed to update bot presence:', err);
  }
  return { status, embed, msg };
}

const commands = [
  new SlashCommandBuilder()
  .setName('link')
  .setDescription('Link your Discord account to your Minecraft account')
  .addStringOption(opt =>
    opt.setName('code')
      .setDescription('4-digit code from .link in Minecraft')
      .setRequired(true)
  ),

new SlashCommandBuilder()
  .setName('mcinfo')
  .setDescription('Show linked Minecraft account info')
  .addUserOption(opt =>
    opt.setName('user')
      .setDescription('Discord user (optional)')
      .setRequired(false)
  ),

  new SlashCommandBuilder()
  .setName('addpyperms')
  .setDescription('Allow a user to run Python commands')
  .addUserOption(opt =>
    opt.setName('user')
      .setDescription('User to allow')
      .setRequired(true)
  ),

new SlashCommandBuilder()
  .setName('removepyperms')
  .setDescription('Remove Python permissions from a user')
  .addUserOption(opt =>
    opt.setName('user')
      .setDescription('User to remove')
      .setRequired(true)
  ),

  new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Manage server whitelist')
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Add a player to the whitelist')
        .addStringOption(option =>
          option.setName('username')
            .setDescription('Minecraft username')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Remove a player from the whitelist')
        .addStringOption(option =>
          option.setName('username')
            .setDescription('Minecraft username')
            .setRequired(true))),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop the Minecraft server (restricted roles only)'),

  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Start the Minecraft server (restricted roles only)'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show current server status and players'),

  new SlashCommandBuilder()
    .setName('ai')
    .setDescription('Ask the server AI a question')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('What you want to ask')
        .setRequired(true)
    ),
].map(command => command.toJSON());


async function askAI(prompt) {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'phi3:mini',
        prompt,
        stream: false,
      }),
    });

    const data = await res.json();
    return data.response?.trim() || 'No response.';
  } catch (err) {
    console.error('AI error:', err);
    return 'AI service is currently unavailable.';
  }
}


async function getUUID(username) {
  try {
    const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${username}`);
    if (!response.ok) {
      return null;
    }
    const data = await response.json();

    const uuid = data.id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
    return uuid;
  } catch (error) {
    console.error('Error fetching UUID:', error);
    return null;
  }
}


async function readWhitelist() {
  try {
    const data = await fs.readFile(WHITELIST_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading whitelist:', error);
    return [];
  }
}


async function writeWhitelist(whitelist) {
  try {
    await fs.writeFile(WHITELIST_PATH, JSON.stringify(whitelist, null, 2));
    return true;
  } catch (error) {
    console.error('Error writing whitelist:', error);
    return false;
  }
}


async function addToWhitelist(username) {
  const whitelist = await readWhitelist();

  if (whitelist.some(entry => entry.name.toLowerCase() === username.toLowerCase())) {
    return { success: false, message: `${username} is already whitelisted!` };
  }

  const uuid = await getUUID(username);
  if (!uuid) {
    return { success: false, message: `Could not find player ${username}. Make sure the username is correct.` };
  }
 
  whitelist.push({ uuid, name: username });
  const success = await writeWhitelist(whitelist);
  
  if (success) {
    const reloaded = await reloadWhitelist();
    const note = reloaded ? '' : ' (server whitelist reload not applied - enable RCON to reload automatically or run "whitelist reload" in console)';
    return { success: true, message: `✅ Added ${username} to the whitelist!${note}` };
  } else {
    return { success: false, message: 'Failed to write to whitelist file.' };
  }
}


async function removeFromWhitelist(username) {
  const whitelist = await readWhitelist();

  const index = whitelist.findIndex(
    entry => entry.name.toLowerCase() === username.toLowerCase()
  );

  if (index === -1) {
    return { success: false, message: `${username} is not whitelisted.` };
  }

  whitelist.splice(index, 1);

  const success = await writeWhitelist(whitelist);
  if (!success) {
    return { success: false, message: 'Failed to write to whitelist file.' };
  }

  const reloaded = await reloadWhitelist();
  const note = reloaded
    ? ''
    : ' (run "whitelist reload" manually or enable RCON)';

  return {
    success: true,
    message: `❌ Removed ${username} from the whitelist!${note}`
  };
}

async function monitorLogs() {
  if (!fsSync.existsSync(LOG_PATH)) {
    console.log('Log file not found. Waiting for server to start...');
    return;
  }

  const lastAiUsage = {}; 
  const AI_COOLDOWN_MS = 5000; 

  const tail = new Tail(LOG_PATH, {
    fromBeginning: false,
    follow: true,
    useWatchFile: false
  });

  tail.on('line', async (line) => {
    try { 
      const joinMatch = line.match(/\[Server thread\/INFO\]: (.+?) joined the game/);
      if (joinMatch) {
        const player = joinMatch[1];
        if (activityChannel) await activityChannel.send(`**${player}** joined the server`);
        return;
      }

      const leaveMatch = line.match(/\[Server thread\/INFO\]: (.+?) left the game/);
      if (leaveMatch) {
        const player = leaveMatch[1];
        if (activityChannel) await activityChannel.send(`**${player}** left the server`);
        return;
      }


const chatMatch = line.match(/^\[.*INFO.*\]: <([^>]+)> (.*)$/);
      if (!chatMatch) return;

      const player = chatMatch[1];
      const message = chatMatch[2];
      
if (message === '.link') {
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  global.pendingLinks[code] = {
    player,
    expires: Date.now() + LINK_CODE_EXPIRY_MS,
  };

  const rcon = await getRconClient();
  if (rcon) {
    await rcon.send(`tell ${player} §aYour Discord link code is §e${code}§a. Use §e/link ${code}§a in Discord.`);
  } else {
    console.log(`[LINK CODE] Player ${player} got code ${code}`);
  }

  return;
}

if (!message.startsWith('.') && chatChannel) {
  chatQueue.push(`**${player}**: ${message}`);
  processChatQueue();
}


if (message.startsWith('.ai ')) {
  (async () => {
    const now = Date.now();
    if (lastAiUsage[player] && now - lastAiUsage[player] < AI_COOLDOWN_MS) {
      const rcon = await getRconClient();
      if (rcon) await rcon.send(`tell ${player} Please wait before using .ai again.`);
      return;
    }
    lastAiUsage[player] = now;

    const prompt = message.slice(4).trim();
    if (!prompt) return;

    let rcon = await getRconClient();
    if (!rcon) return;

    try {
      const answer = await askAI(prompt);

      const MAX_LEN = 240;
      for (let i = 0; i < answer.length; i += MAX_LEN) {
        await rcon.send(`say [${player}] ${answer.slice(i, i + MAX_LEN)}`);
      }
    } catch (err) {
      console.error('AI command error:', err);
      rcon = await getRconClient();
      if (rcon) await rcon.send(`say [Server AI] AI service is unavailable.`);
    }
  })();

  return;
}


    } catch (err) {
      console.error('Error processing log line:', err);
    }
  });

  tail.on('error', (err) => console.error('Error watching log file:', err));

  console.log('Started monitoring server logs with .ai /say output');
}


async function cleanupStatusChannelOnStartup() {
  const channel = await getStatusChannel();
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const botMessages = messages.filter(
      msg => msg.author.id === client.user.id
    );

    for (const msg of botMessages.values()) {
      await msg.delete().catch(() => {});
    }

    console.log(`🧹 Deleted ${botMessages.size} old status messages`);
  } catch (err) {
    console.error('Failed to clean status channel:', err);
  }
}



client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);


  const rest = new REST({ version: '10' }).setToken(TOKEN);

  try {
    console.log('Registering slash commands for guilds...');
    const guilds = await client.guilds.fetch();
    for (const guild of guilds.values()) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commands }
      );
      console.log(`✅ Registered commands for guild ${guild.id}`);
    }
    console.log('✅ Slash commands registered for all guilds');
  } catch (error) {
    console.error('Error registering commands:', error);
  }

  try {
    activityChannel = await client.channels.fetch(ACTIVITY_CHANNEL_ID);
    console.log(`✅ Activity channel fetched: ${ACTIVITY_CHANNEL_ID}`);
  } catch (error) {
    console.error('Failed to fetch activity channel on startup:', error);
  }

  try {
    chatChannel = await client.channels.fetch(CHAT_CHANNEL_ID);
    console.log(`✅ Chat channel fetched: ${CHAT_CHANNEL_ID}`);
  } catch (error) {
    console.error('Failed to fetch chat channel on startup:', error);
  }

  try {
    statusChannel = await client.channels.fetch(STATUS_CHANNEL_ID);
    console.log(`✅ Status channel fetched: ${STATUS_CHANNEL_ID}`);
  } catch (error) {
    console.error('Failed to fetch status channel on startup:', error);
  }
await cleanupStatusChannelOnStartup();
await updateStatusMessageOnce();


  monitorLogs();


  setInterval(() => {
    updateStatusMessageOnce().catch((err) => console.error('Status update failed:', err));
  }, STATUS_UPDATE_INTERVAL_MS);
});



function getPlayTimesFromLogs(playerName) {
  const logsDir = path.join(__dirname, '..', 'logs');
  if (!fsSync.existsSync(logsDir)) return null;

  
  const files = fsSync.readdirSync(logsDir)
    .filter(f => f.endsWith('.log'))
    .map(f => {
      const filePath = path.join(logsDir, f);
      const stats = fsSync.statSync(filePath);
      return { filePath, mtime: stats.mtime };
    })
    .sort((a, b) => a.mtime - b.mtime); 

  let firstJoin = null;
  let lastSeen = null;

  const joinRegex = new RegExp(`\\b${playerName} joined the game\\b`);
  const leaveRegex = new RegExp(`\\b${playerName} left the game\\b`);

  for (const { filePath, mtime } of files) {
    const content = fsSync.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (const line of lines) {
      const tsMatch = line.match(/^\[(\d{2}):(\d{2}):(\d{2})]/);
      if (!tsMatch) continue;

      const [_, hh, mm, ss] = tsMatch;

      const dt = new Date(mtime);
      dt.setHours(parseInt(hh, 10), parseInt(mm, 10), parseInt(ss, 10));


      const dtGMT2 = new Date(dt.getTime() + 2 * 60 * 60 * 1000);

      if (joinRegex.test(line)) {
        if (!firstJoin || dtGMT2 < firstJoin) firstJoin = dtGMT2;
        if (!lastSeen || dtGMT2 > lastSeen) lastSeen = dtGMT2;
      }

      if (leaveRegex.test(line)) {
        if (!lastSeen || dtGMT2 > lastSeen) lastSeen = dtGMT2;
      }
    }
  }

  if (!firstJoin && !lastSeen) return null;

  return {
    firstJoin: firstJoin.toLocaleString('en-GB', { timeZone: 'Europe/Berlin' }),
    lastSeen: lastSeen.toLocaleString('en-GB', { timeZone: 'Europe/Berlin' }),
  };
}



client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const commandName = interaction.commandName;

  
  if (commandName === 'link') {
    await interaction.deferReply({ ephemeral: true });

    const code = interaction.options.getString('code');
    const entry = global.pendingLinks[code];

    if (!entry) return interaction.editReply('❌ Invalid or expired code.');
    if (Date.now() > entry.expires) {
      delete global.pendingLinks[code];
      return interaction.editReply('❌ This code has expired.');
    }


    for (const uid in global.linkedAccounts) {
      if (global.linkedAccounts[uid].player === entry.player) {
        return interaction.editReply(
          '❌ This Minecraft account is already linked to another Discord account.'
        );
      }
    }

 
    global.linkedAccounts[interaction.user.id] = {
      player: entry.player,
      linkedAt: new Date().toISOString(),
    };
    saveLinkedAccounts();
    delete global.pendingLinks[code];

    console.log('Linked accounts:', global.linkedAccounts); 

    return interaction.editReply(
      `✅ Successfully linked to Minecraft account **${entry.player}**`
    );
  }

  if (commandName === 'mcinfo') {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const link = global.linkedAccounts[targetUser.id];

    if (!link) {
      return interaction.editReply('❌ This user has not linked a Minecraft account.');
    }

    const playTimes = getPlayTimesFromLogs(link.player);

    let reply = `🧱 **Minecraft Info**\n`;
    reply += `**Player:** ${link.player}\n`;
    reply += `**Linked Discord:** <@${targetUser.id}>\n`;
    reply += `**Linked At:** ${new Date(link.linkedAt).toLocaleString()}\n`;

    if (playTimes) {
      reply += `\n📜 **Server History**\n`;
      reply += `**First Joined:** ${playTimes.firstJoin ?? 'Unknown'}\n`;
      reply += `**Last Seen:** ${playTimes.lastSeen ?? 'Unknown'}\n`;
    } else {
      reply += `\n📜 **Server History**\nNo log data found.`;
    }

    return interaction.editReply(reply);
  }

  if (commandName === 'addpyperms') {
    await interaction.deferReply({ ephemeral: true });

    if (!isAuthorized(interaction)) {
      return interaction.editReply('❌ You are not allowed to manage Python permissions.');
    }

    const user = interaction.options.getUser('user');
    const perms = loadPyPerms();

    if (perms.includes(user.id)) {
      return interaction.editReply('⚠️ User already has Python permissions.');
    }

    perms.push(user.id);
    savePyPerms(perms);

    return interaction.editReply(`✅ ${user.tag} can now use \`!python\`.`);
  }

  if (commandName === 'removepyperms') {
    await interaction.deferReply({ ephemeral: true });

    if (!isAuthorized(interaction)) {
      return interaction.editReply('❌ You are not allowed to manage Python permissions.');
    }

    const user = interaction.options.getUser('user');
    let perms = loadPyPerms();

    perms = perms.filter(id => id !== user.id);
    savePyPerms(perms);

    return interaction.editReply(`❌ ${user.tag} can no longer use \`!python\`.`);
  }


  if (commandName === 'whitelist') {
    await interaction.deferReply();

    const subcommand = interaction.options.getSubcommand();
    const username = interaction.options.getString('username');

    let result;
    if (subcommand === 'add') {
      result = await addToWhitelist(username);
    } else if (subcommand === 'remove') {
      result = await removeFromWhitelist(username);
    }

    return interaction.editReply(result.message);
  }


  if (commandName === 'stop') {
    await interaction.deferReply({ ephemeral: true });

    if (!isAuthorized(interaction)) {
      return interaction.editReply('You do not have permission to run this command.');
    }

    const result = await stopServer();
    return interaction.editReply(result.message);
  }


  if (commandName === 'start') {
    await interaction.deferReply({ ephemeral: true });

    if (!isAuthorized(interaction)) {
      return interaction.editReply('You do not have permission to run this command.');
    }

    const result = await startServer();
    return interaction.editReply(result.message);
  }


  if (commandName === 'status') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const { status, embed, msg } = await updateStatusMessageOnce();
      if (msg) {
        return interaction.editReply('Updated status message.');
      } else {
        return interaction.editReply({ content: 'Could not reach status channel; showing here.', embeds: [embed] });
      }
    } catch (error) {
      console.error('Failed to send status embed:', error);
      try {
        const status = await getServerStatus();
        const embed = buildStatusEmbed(status);
        return interaction.editReply({ content: 'Could not post in the status channel. Showing here instead.', embeds: [embed] });
      } catch (err2) {
        return interaction.editReply('Failed to fetch status.');
      }
    }
  }


  if (commandName === 'ai') {
    await interaction.deferReply();

    const prompt = interaction.options.getString('prompt');

    try {
      const answer = await askAI(prompt);
      const trimmed = answer.length > 2000 ? answer.slice(0, 1997) + '...' : answer;

      return interaction.editReply(trimmed);
    } catch (err) {
      console.error(err);
      return interaction.editReply('❌ AI failed to respond.');
    }
  }
});


client.on('messageCreate', async (message) => {
  if (message.author.bot || message.webhookId) return;

  if (message.content.startsWith('!python')) {
    if (!hasPythonPerm(message.author.id)) {
      return message.reply('❌ You do not have permission to use Python.');
    }

    const code = message.content.slice('!python'.length).trim();
    if (!code) {
      return message.reply('❌ Please provide Python code.');
    }

    await message.reply('🐳 Running Python in Docker sandbox...');
    try {
      const result = await runPythonDocker(code);
      await message.reply(result);
    } catch (err) {
      console.error(err);
      await message.reply('❌ An error occurred while running Python.');
    }
    return;
  }

  if (message.channelId !== CHAT_CHANNEL_ID) return;

  const text = (message.content || '').trim();
  const attachmentText = message.attachments?.size
    ? [...message.attachments.values()].map(a => a.url).join(' ')
    : '';
  const combined = [text, attachmentText].filter(Boolean).join(' ').trim();
  if (!combined) return;

  const displayName = message.member?.displayName || message.author.username;
  const result = await relayDiscordMessageToMinecraft(displayName, combined);

  if (result.success) {
    try {
      await message.reply({ content: '✅ Sent to in-game chat.', allowedMentions: { repliedUser: false } });
    } catch (err) {
      console.error(err);
    }
  } else {
    try {
      await message.reply({ content: result.message || 'Could not send to server (RCON unavailable).', allowedMentions: { repliedUser: false } });
    } catch (err) {
      console.error(err);
    }
  }
});



client.login(TOKEN).catch(error => {
  console.error('Failed to login:', error);
  process.exit(1);
});


process.on('SIGINT', () => {
  console.log('Shutting down bot...');
  client.destroy();
  process.exit(0);
});
