# Claude Code Remote Access

Control Claude Code from your iPhone with real-time output streaming, text-to-speech, and voice input.

## Features

- **📡 Real-time streaming** - See Claude's responses as they're generated
- **🔊 Text-to-speech** - Have responses read aloud
- **🎤 Voice input** - Dictate commands using your microphone
- **🔔 Push notifications** - Get notified when Claude responds
- **📂 Multi-session** - Switch between Claude Code sessions
- **⚡ Quick actions** - One-tap /clear, /compact, yes, cancel

## Quick Setup

```bash
# 1. Install
cd claude-remote-access
npm install

# 2. Generate token and start
export AUTH_TOKEN=$(openssl rand -hex 32)
echo "Save this token: $AUTH_TOKEN"
npm start

# 3. In another terminal, start tunnel
brew install cloudflared
cloudflared tunnel --url http://localhost:3456
# Copy the https URL it gives you

# 4. Open that URL on your iPhone, enter token, done!
```

## Requirements

- Grant Terminal accessibility permissions:
  **System Settings → Privacy & Security → Accessibility → Add Terminal**

## Usage

- **Type or voice** commands in the input
- **Quick buttons** for common actions
- **🔇/🔊 toggle** for text-to-speech
- **⚙️ settings** for voice selection, speed, notifications
- **Dropdown** to switch sessions

## Run Persistently

```bash
npm install -g pm2
AUTH_TOKEN=your-token pm2 start server.js --name claude-remote
pm2 start cloudflared --name tunnel -- tunnel --url http://localhost:3456
pm2 save && pm2 startup
```
