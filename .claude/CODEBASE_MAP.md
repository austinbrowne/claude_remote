# Claude Remote — Codebase Map

## Architecture

Mobile companion for monitoring/controlling Claude Code sessions in iTerm.
**Stack:** Node.js (Express + WS) → Cloudflare Tunnel → Web PWA + iOS App

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│  iOS App /  │────▶│  cloudflared │────▶│  Express:3456  │
│  Web PWA    │ WSS │  (SSL term)  │ WS  │  + WS Server   │
└─────────────┘     └──────────────┘     └───────┬────────┘
                                                  │
                    ┌──────────────┐     ┌────────▼────────┐
                    │  iTerm2 Tabs │◀────│  AppleScript    │
                    │  (Claude)    │     │  Injection      │
                    └──────┬───────┘     └─────────────────┘
                           │
                    ┌──────▼───────┐
                    │  JSONL Logs  │  (chokidar watch)
                    │  ~/.claude/  │
                    └──────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express + WS server, session routing, auth, state sync |
| `lib/session-discovery.js` | ps + lsof to find active Claude processes/TTYs |
| `lib/watcher.js` | chokidar file watcher, JSONL incremental read, subagent streams |
| `lib/log-parser.js` | JSONL → typed items (assistant, tool, permission, milestone) |
| `lib/command-injection.js` | AppleScript → iTerm2 TTY command/control injection |
| `lib/file-api.js` | REST file browser with path traversal protection |
| `lib/commands.js` | Slash command discovery (built-in, user, project, plugin) |
| `lib/utils.js` | Constants, ANSI strip, secure token compare |
| `public/` | Web PWA (JS modules: connection, state, ui, sessions, prompts) |
| `ClaudeRemote/` | Native iOS app (SwiftUI, URLSession WS, Keychain) |
| `restart.sh` | Stop/start server + restart cloudflared tunnel |

## Networking

- **Port:** 3456 (env `PORT`)
- **Auth:** Bearer token (64-char hex), timing-safe comparison
- **Tunnel:** cloudflared LaunchAgent → `claude.dazztrazak.com`
- **SSL:** Terminated by cloudflared, Node.js runs plain HTTP/WS

## Session Lifecycle

1. `discoverSessions()` — ps finds claude processes, maps PID→TTY→CWD
2. `watchSession()` — chokidar watches `~/.claude/projects/{hash}/{sessionId}.jsonl`
3. `processLogChanges()` — incremental JSONL read → parse → broadcast via WS
4. `injectCommandToTty()` — AppleScript writes to iTerm tab by TTY match
