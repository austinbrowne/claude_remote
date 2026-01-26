# Claude Remote

Mobile companion app for monitoring and controlling Claude Code sessions running in iTerm.

## Development

### After Any Code Change

Always restart the server to test changes locally:

```bash
./restart.sh
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
  - Discovers active Claude sessions from iTerm tabs
  - Watches session log files for real-time updates
  - Injects commands via AppleScript

- `public/index.html` - Mobile-optimized single-page app with:
  - Real-time session output streaming
  - Voice input/output (TTS)
  - Quick action buttons
  - Push notifications

### Key Functions

- `getActiveITermSessions()` - Queries iTerm for tabs running Claude
- `discoverSessions()` - Maps active tabs to Claude session log files
- `watchSession()` - Sets up file watcher for real-time streaming
- `getSessionStatus()` - Determines if session is waiting/processing/idle
