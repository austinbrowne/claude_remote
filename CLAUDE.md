# Claude Remote

Mobile companion app for monitoring and controlling Claude Code sessions. Supports macOS (iTerm/AppleScript) and Linux (tmux).

## Development

### After Any Code Change

Always restart the server to test changes locally:

```bash
./restart.sh
```

### Running Tests

```bash
node --test test/*.test.js
```

### Server Scripts

| Script | Description |
|--------|-------------|
| `./start.sh` | Start the server (requires AUTH_TOKEN) |
| `./stop.sh` | Stop the server |
| `./restart.sh` | Stop and restart the server |

### First Time Setup

1. Generate an auth token:
   ```bash
   openssl rand -hex 32
   ```

2. Create `.env` file:
   ```bash
   echo "AUTH_TOKEN=your_generated_token" > .env
   ```

3. Start the server:
   ```bash
   ./start.sh
   ```

### Architecture

- `server.js` - Express + WebSocket server that:
  - Discovers active Claude sessions via platform adapter (iTerm or tmux)
  - Watches session log files for real-time updates
  - Broadcasts sequenced events with dedup and delta replay
  - Tracks server-side pending prompt state for reconnect recovery
  - Injects commands via platform adapter

- `lib/platform/` - Platform adapters:
  - `detect.js` - Auto-detects platform (darwin → macOS, linux → tmux)
  - `macos-iterm.js` - AppleScript-based session discovery and injection
  - `linux-tmux.js` - tmux-based session discovery and injection

- `public/` - Mobile-optimized single-page app with:
  - Real-time session output streaming via WebSocket
  - Sequence-based dedup and cursor-based delta replay on reconnect
  - Pending prompt recovery on reconnect
  - Voice input/output (TTS)
  - Quick action buttons

### Key Functions

- `getActiveClaude()` - Delegates to platform adapter to find Claude sessions
- `discoverSessions()` - Maps active sessions to Claude JSONL log files
- `watchSession()` - Sets up file watcher for real-time streaming
- `getSessionStatus()` - Determines if session is waiting/processing/idle
- `broadcastToClients()` - Broadcasts sequenced events, manages recentEvents buffer
- `updatePromptState()` - Tracks pending prompts server-side for recovery
- `safeSend()` - WebSocket send with try/catch for CLOSING/CLOSED sockets
