# VanduxMC Discord Bot

Discord bot for monitoring VanduxMC server activity and managing the whitelist.

## Features

- 📥📤 **Join/Leave Logging**: Automatically logs when players join or leave the server
- 💬 **Chat Logging**: Forwards all in-game chat messages to Discord
- ⚙️ **Whitelist Management**: Use `/whitelist add/remove <username>` to manage the server whitelist

## Setup

1. Install dependencies:
```bash
npm install
```

2. Start the bot:
```bash
npm start
```

## Commands

- `/whitelist add <username>` - Add a player to the whitelist
- `/whitelist remove <username>` - Remove a player from the whitelist

## Configuration

The bot monitors the server logs at `../logs/latest.log` and manages the whitelist at `../whitelist.json`.

All activity is logged to Discord channel ID: 1449934553417519356
