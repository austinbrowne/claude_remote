# Claude Code Remote Access

Control Claude Code from your phone with real-time output streaming, text-to-speech, and voice input. Works on macOS (iTerm) and Linux (tmux).

## Features

- **Real-time streaming** - See Claude's responses as they're generated
- **Text-to-speech** - Have responses read aloud
- **Voice input** - Dictate commands using your microphone
- **Push notifications** - Get notified when Claude responds
- **Multi-session** - Switch between Claude Code sessions
- **Quick actions** - One-tap /clear, /compact, yes, cancel
- **Reconnect recovery** - Sequence-based dedup and delta replay on reconnect
- **Prompt persistence** - Server-side pending prompt state survives disconnects

## Quick Setup

### 1. Install

```bash
cd claude-remote-access
npm install
```

### 2. Generate token

```bash
echo "AUTH_TOKEN=$(openssl rand -hex 32)" > .env
```

### 3. Start server

```bash
./start.sh
```

### 4. Connect from your phone

**Option A — Cloudflare Tunnel (macOS):**
```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3456
# Open the https URL on your phone, enter token, done
```

**Option B — Tailscale (Linux or macOS):**
```bash
# See docs/tailscale-setup.md for full guide
tailscale ip -4   # note this IP
# Open http://<tailscale-ip>:3456 on your phone
```

## Platform Requirements

**macOS:**
- iTerm2
- Grant Terminal accessibility permissions:
  **System Settings > Privacy & Security > Accessibility > Add Terminal**

**Linux:**
- tmux (Claude sessions must run inside tmux panes)
- Start Claude in tmux: `tmux new -s claude` then `claude`
- Start the server in a separate tmux pane

## Usage

- **Type or voice** commands in the input
- **Quick buttons** for common actions
- **TTS toggle** for text-to-speech
- **Settings** for voice selection, speed, notifications
- **Dropdown** to switch sessions

## Run Persistently

```bash
npm install -g pm2
AUTH_TOKEN=your-token pm2 start server.js --name claude-remote
pm2 save && pm2 startup
```
