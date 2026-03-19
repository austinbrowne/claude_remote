# Linux Port Plan — Claude Remote via Tailscale

## Overview

Port the Claude Remote server from macOS/iTerm to Linux, accessed remotely via Tailscale from a mobile device.

**[DEEPENED] Scope clarification:** This is a cross-platform port, not a fork. Both macOS and Linux will be supported through a platform adapter abstraction. The macOS implementation remains intact; a new Linux/tmux implementation is added behind the same interface.

---

## What Works As-Is on Linux

| Component | File | Notes |
|-----------|------|-------|
| Log file watching | `lib/watcher.js` | chokidar is cross-platform; `~/.claude/projects/` exists on Linux |
| Log parsing | `lib/log-parser.js` | Pure JS, no OS dependencies |
| WebSocket server + protocol | `server.js` | Express + ws, zero macOS-specific code (confirmed by codebase research) |
| Web UI | `public/` | Standard HTML/CSS/JS PWA |
| File API | `lib/file-api.js` | Standard Node.js fs calls |
| Auth, rate limiting, utilities | `lib/utils.js` | Pure JS (secureCompare, stripAnsi, etc.) |

**[DEEPENED] One watcher.js change needed:** Line 854 checks `/^ttys\d+$/.test(tty)` before writing to `/dev/${tty}` for subagent auto-approval. Must be updated to also match `pts/\d+` format.

---

## Architecture Decision: Platform Adapter Pattern

**[DEEPENED] New section — addresses ARCH-001 (CRITICAL), ARCH-004 (HIGH)**

Rather than replacing macOS code with Linux code, introduce a `lib/platform/` adapter module:

```
lib/platform/
├── adapter.js          # Interface definition + platform auto-detection
├── macos.js            # Existing AppleScript/iTerm implementation (extracted)
└── linux-tmux.js       # New tmux implementation
```

**Adapter interface:**
```js
// Selected at startup via process.platform or CLAUDE_REMOTE_PLATFORM env var
{
  discoverSessions()           → Promise<[{id, pid, tty, cwd}]>
  injectCommand(paneId, text)  → Promise<void>
  sendControlChar(paneId, char)→ Promise<void>
  selectOption(paneId, index)  → Promise<void>
  prepareForInjection(paneId)  → Promise<void>
  sendModeToggle(paneId)       → Promise<void>
  validateTarget(id)           → boolean
  healthCheck()                → Promise<{ok, error?}>
}
```

**Benefits:**
- macOS support preserved (no regression)
- Clean testability (mock the adapter)
- Platform concerns isolated behind a contract
- Callers in `server.js` and `watcher.js` remain unchanged

---

## Session Identity Model

**[DEEPENED] New section — addresses ARCH-006 (MEDIUM), EC-008 (HIGH)**

**Decision:** Use **tmux pane ID** (`%N`) as the primary session identifier on Linux.

| Property | macOS (current) | Linux (new) |
|----------|----------------|-------------|
| Session ID source | JSONL filename UUID, fallback `{tty}-{pid}` | JSONL filename UUID, fallback `{paneId}-{pid}` |
| Target for injection | TTY (`ttys001`) | Pane ID (`%3`) |
| Validation regex | `^ttys\d+$` | `^%\d+$` |

**Why pane ID over PID or TTY:**
- PIDs change when Claude restarts in the same pane (EC-008) — pane ID stays stable
- TTY format (`pts/3`) contains a slash, complicating path-based operations — pane ID is clean
- Pane IDs are unique within a tmux server and are the native `send-keys -t` target
- `$TMUX_PANE` env var lets the server exclude itself (EC-009)

**Process tree resolution (EC-001):** Claude Code forks child processes, so `pane_pid` (shell PID) won't match the Claude PID from `ps`. Resolution strategy:
1. Use `tmux list-panes -a -F "#{pane_id} #{pane_pid} #{pane_current_command} #{pane_current_path}"` as the single source of truth
2. Match by `pane_current_command` containing "claude" rather than PID equality
3. Cross-reference with JSONL log file discovery from `~/.claude/projects/` using `pane_current_path`

---

## What Needs Adaptation

### 1. Session Discovery — Use tmux as Sole Source

**[DEEPENED] Resolved ambiguity flagged by SIMP-001, ARCH-003, PERF-001 (4 agents)**

**Decision:** Use `tmux list-panes` as the **sole** discovery mechanism. Do not maintain a parallel `ps + grep + lsof` path.

**Single command replaces three:**
```bash
tmux list-panes -a -F "#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}"
```

Returns structured output like:
```
%0|12345|claude|/home/user/project
%1|12346|node|/home/user/claude_remote
%3|12347|bash|/home/user
```

**Discovery logic:**
1. Run `tmux list-panes -a -F ...` (single process spawn, ~5ms)
2. Filter panes where `pane_current_command` contains "claude"
3. Exclude server's own pane via `$TMUX_PANE` env var (EC-009)
4. For each matching pane, scan `~/.claude/projects/` for JSONL logs where `pane_current_path` matches the project hash
5. Return session objects with `{id: paneId, pid, cwd, logFile}`

**Eliminates:**
- `ps -eo pid,tty,command | grep` (fragile string parsing)
- `lsof -a -p <pids> -d cwd` (N+1 process spawns for CWD lookup)
- TTY regex validation entirely (pane IDs are `%\d+`, clean format)

**[DEEPENED] Failure modes (ARCH-002, EC-005, FLOW-001, FLOW-005):**

| Condition | Detection | Server behavior | Client message |
|-----------|-----------|----------------|----------------|
| tmux not installed | `which tmux` at startup | Refuse to start, log error | N/A (server won't run) |
| tmux server not running | Exit code 1 + stderr "no server running" | Return empty session list | "No tmux server running. Start one with: `tmux new -s claude`" |
| tmux running, no Claude panes | Filter returns 0 results | Return empty session list | "No Claude sessions found. Run `claude` inside a tmux pane." |
| Claude running outside tmux | Not discovered (by design) | Not shown | "Claude must run inside tmux for remote control." |
| Pane destroyed between discovery and injection | `send-keys` exit code ≠ 0 | Return error to client | "Session ended. Refresh to see active sessions." |

**[DEEPENED] Staleness and refresh (EC-006):**
- Poll `tmux list-panes` every 5 seconds to reconcile session list
- Push `sessions` update to all connected clients when list changes
- Client can also trigger manual refresh via existing `refresh_sessions` action

### 2. Command Injection — tmux send-keys

**[DEEPENED] Addresses SEC-001 (CRITICAL), EC-003 (CRITICAL), EC-014 (MEDIUM)**

**CRITICAL: Sanitization strategy** (flagged by 3 agents as highest-risk change)

The transition from AppleScript to `tmux send-keys` changes the injection surface. AppleScript was sandboxed to iTerm scripting; tmux commands are passed through the shell. This requires explicit mitigation:

1. **Use `execFile`, never `exec`** — Pass arguments as an array to bypass the shell entirely. This eliminates shell metacharacter injection.
   ```js
   // CORRECT: No shell involved
   execFile('tmux', ['send-keys', '-t', paneId, '-l', text], callback)

   // WRONG: Shell interprets metacharacters
   exec(`tmux send-keys -t ${paneId} "${text}"`, callback)  // NEVER DO THIS
   ```

2. **Use `-l` flag (literal mode)** — Prevents tmux from interpreting key names (`Enter`, `Escape`, `C-c`, etc.) in the text payload. Literal mode sends raw characters.
   ```js
   // For text input: -l flag, literal mode
   execFile('tmux', ['send-keys', '-t', paneId, '-l', command])
   // For special keys: separate call, no -l flag
   execFile('tmux', ['send-keys', '-t', paneId, 'Enter'])
   ```

3. **Validate pane ID** — Strict regex `^%\d+$` before any tmux call. Reject anything else.

4. **Preserve existing sanitization** — Strip null bytes and control characters from user input before sending.

5. **Maximum command length** — Enforce a reasonable limit (e.g., 4096 chars).

**Function mapping (revised):**

| Function | Implementation | Notes |
|----------|---------------|-------|
| `injectCommand(paneId, text)` | `execFile('tmux', ['send-keys', '-t', paneId, '-l', text])` then `execFile('tmux', ['send-keys', '-t', paneId, 'Enter'])` | Two calls: literal text + Enter key |
| `selectOption(paneId, index)` | Loop: `execFile('tmux', ['send-keys', '-t', paneId, 'Down'])` × N, then `Enter` | Sequential with 10ms gaps |
| `sendControlChar(paneId, char)` | `execFile('tmux', ['send-keys', '-t', paneId, charName])` | Map charCode → tmux name: 27→`Escape`, 21→`C-u` |
| `prepareForInjection(paneId)` | Send `Escape`, wait 100ms, send `C-u`, wait 50ms | **[DEEPENED] Reduced from 1.5s+0.5s** — AppleScript delays were iTerm-specific (PERF-005). tmux send-keys completes in <5ms. |
| `sendModeToggle(paneId)` | `execFile('tmux', ['send-keys', '-t', paneId, 'BTab'])` | Shift+Tab = BTab in tmux |

**[DEEPENED] Per-pane command mutex (EC-007):**
Injection sequences (prep + text + Enter) must be atomic per pane. Add a per-pane promise queue so concurrent injection requests serialize rather than interleave:
```js
const paneQueues = new Map()  // paneId → Promise chain
function withPaneLock(paneId, fn) {
  const prev = paneQueues.get(paneId) || Promise.resolve()
  const next = prev.then(fn).catch(fn)
  paneQueues.set(paneId, next)
  return next
}
```

**Legacy functions:** `injectCommandLegacy` and `sendEscapeKeyLegacy` are eliminated entirely (macOS-only, pbcopy-based).

### 3. Additional File Changes

**[DEEPENED] Comprehensive file change list (revised):**

| File | Change | Scope |
|------|--------|-------|
| `lib/platform/adapter.js` | **New** — Platform interface + auto-detection | ~50 lines |
| `lib/platform/linux-tmux.js` | **New** — tmux implementation of adapter | ~200 lines |
| `lib/platform/macos.js` | **Extract** from current `command-injection.js` + `session-discovery.js` | ~400 lines (moved) |
| `lib/command-injection.js` | **Refactor** — Thin wrapper delegating to platform adapter | ~50 lines (down from 333) |
| `lib/session-discovery.js` | **Refactor** — Thin wrapper delegating to platform adapter | ~100 lines (down from 340) |
| `lib/watcher.js:854` | Update TTY regex for subagent auto-approval | 1 line |
| `lib/utils.js` | Remove `validateTty` (replaced by adapter's `validateTarget`) | ~5 lines removed |
| `server.js` | Import adapter; pass to watcher/injection callers | ~10 lines changed |
| `start.sh` | Add prerequisite checks (Node, tmux, AUTH_TOKEN) | ~15 lines |

---

## Networking Setup — Tailscale

**[DEEPENED] HTTPS required, not optional (SEC-002, best practices research)**

### Server (Linux machine)

```bash
# Install Tailscale (Fedora)
sudo dnf install tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up

# Get Tailscale hostname and IP
tailscale status --json | jq -r '.Self.DNSName'
tailscale ip -4

# Generate HTTPS certificate (REQUIRED for secure token transport)
tailscale cert $(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')
```

### HTTPS Configuration

The server should support TLS when cert files are present:
```js
// In server.js startup
const certPath = process.env.TLS_CERT || `${hostname}.crt`
const keyPath = process.env.TLS_KEY || `${hostname}.key`
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  https.createServer({cert, key}, app)  // HTTPS
} else {
  http.createServer(app)  // HTTP fallback with warning
  console.warn('WARNING: Running without TLS. Token transmitted in cleartext.')
}
```

**[DEEPENED] Bind to Tailscale interface (SEC-005):**
- Default bind: `0.0.0.0` (current) — accessible on all interfaces
- Recommended: Set `LISTEN_HOST` env var to the Tailscale IP (`100.x.x.x`) to restrict to Tailscale only
- Document in setup: `LISTEN_HOST=100.x.x.x` in `.env`

**[DEEPENED] Tailscale ACLs:**
- Recommend restricting port 3456 access to specific devices in Tailscale admin console
- Document the ACL configuration step in setup instructions

### Phone (iOS/Android)

1. Install Tailscale app from App Store / Play Store
2. Sign in to the same Tailscale account
3. Access via `https://<tailscale-hostname>:3456` (MagicDNS)

---

## Startup Prerequisite Checks

**[DEEPENED] New section — addresses FLOW-004, EC-012**

`start.sh` must validate before launching the server:

```bash
#!/bin/bash
set -euo pipefail

# Check Node.js
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js not installed"; exit 1; }

# Check tmux (Linux only)
if [[ "$(uname)" != "Darwin" ]]; then
  command -v tmux >/dev/null 2>&1 || { echo "ERROR: tmux not installed. Install with: sudo dnf install tmux"; exit 1; }
fi

# Check AUTH_TOKEN
source .env 2>/dev/null || true
if [[ -z "${AUTH_TOKEN:-}" ]]; then
  echo "ERROR: AUTH_TOKEN not set. Create .env with: echo 'AUTH_TOKEN=$(openssl rand -hex 32)' > .env"
  exit 1
fi

# Check token length
if [[ ${#AUTH_TOKEN} -lt 32 ]]; then
  echo "ERROR: AUTH_TOKEN must be at least 32 characters"
  exit 1
fi

# Start server
node server.js
```

**Server-side health check** (adapter.healthCheck()):
- On Linux: verify tmux is running, report pane count
- Exposed at `/health/detailed` (existing endpoint, extended)

---

## Workflow

1. SSH into Linux machine (or use local terminal)
2. Start a tmux session: `tmux new -s claude`
3. Run Claude Code inside tmux: `claude`
4. **In a separate tmux pane** (`Ctrl+B %`): `./start.sh`
5. On phone, open `https://<tailscale-hostname>:3456`
6. Authenticate with AUTH_TOKEN
7. Server discovers Claude session via `tmux list-panes`, watches JSONL logs, streams output to phone

**[DEEPENED] Server must not run in the same pane as Claude** — the server records its own pane via `$TMUX_PANE` and excludes it from discovery (EC-009).

---

## Performance Considerations

**[DEEPENED] New section — addresses PERF-001 through PERF-007**

| Area | macOS (current) | Linux (improved) |
|------|----------------|-----------------|
| Session discovery | `ps` + `lsof` (2+ process spawns) | `tmux list-panes` (1 spawn, ~5ms) |
| Command injection | AppleScript IPC (200ms+ delays) | `execFile` tmux (< 5ms, no artificial delays) |
| File watching | chokidar polling 500ms + FSEvents | chokidar with `usePolling: false` (inotify, kernel-pushed) |
| Fallback poll | 2s interval (covers FSEvents gaps) | Remove — inotify is reliable. Add watchdog for inotify limits only. |
| Context % poll | 10s timer on `/tmp/` | Consider inotify on tmpfs (supported on Linux) |
| WS keep-alive | 30s ping/pong | Keep 30s — below WireGuard's 180s idle threshold (PERF-004) |

**inotify limits check at startup:**
```js
// Log warning if limits are low
const maxWatches = parseInt(fs.readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8'))
if (maxWatches < 8192) {
  console.warn(`inotify max_user_watches is ${maxWatches}. Recommend: sudo sysctl fs.inotify.max_user_watches=65536`)
}
```

---

## Error States and User-Facing Messages

**[DEEPENED] New section — addresses FLOW-001 through FLOW-015**

### Session Discovery States

| State | Client UI |
|-------|-----------|
| Server reachable, no tmux running | "No tmux server running. Start with: `tmux new -s claude`" |
| tmux running, no Claude sessions | "No Claude sessions found. Run `claude` inside a tmux pane." |
| Claude running outside tmux | Not discoverable (by design) — same as "no sessions" |
| Session dies while monitoring | Push `session_status: 'ended'` → UI shows "Session ended" toast |

### Connection States

| State | Client UI |
|-------|-----------|
| Server unreachable (Tailscale down) | PWA shows "Cannot connect — check Tailscale is active on both devices" |
| Auth failure | "Invalid token — check AUTH_TOKEN in .env on server" |
| WebSocket disconnect (phone backgrounded) | "Reconnecting..." with auto-retry (exponential backoff, existing logic) |
| Reconnected after gap | "Reconnected" toast + catch-up via existing `catch_up` action |

### Permission Prompt Persistence

| State | Behavior |
|-------|----------|
| Phone backgrounded during permission prompt | Prompt preserved in server state. On WS reconnect, pending prompts replayed via `history` send. |
| Claude times out waiting for permission | Claude's own timeout applies. Server shows the timeout as a new output event. |

### Multi-Session UX

When multiple Claude panes exist, session list shows:
- tmux window name + pane index (e.g., "claude:0.1")
- Working directory (e.g., `/home/user/my-project`)
- Session status (waiting/processing/idle)

---

## Security Considerations

**[DEEPENED] New section — consolidates SEC-001 through SEC-009**

### Threat Model Change

| Aspect | macOS (current) | Linux + Tailscale |
|--------|----------------|-------------------|
| Network exposure | localhost or Cloudflare tunnel (HTTPS) | Tailscale tailnet (WireGuard encrypted) |
| Injection surface | AppleScript (sandboxed to iTerm scripting) | tmux send-keys via `execFile` (no shell) |
| Multi-user risk | Single-user macOS | Possible shared Linux server |

### Mitigations

1. **Shell injection prevention:** `execFile` (not `exec`) for all tmux calls — shell never invoked (SEC-001, EC-003)
2. **Literal mode:** `send-keys -l` for text, separate calls for special keys (EC-014)
3. **Pane ID validation:** Strict `^%\d+$` before any tmux operation (SEC-004)
4. **Session ownership:** `tmux list-panes` is scoped to the running user's tmux server by default (SEC-003)
5. **Self-exclusion:** Server excludes its own `$TMUX_PANE` from discovery (EC-009)
6. **HTTPS:** Tailscale certs required for secure token transport (SEC-002)
7. **Bind restriction:** `LISTEN_HOST` env var to bind to Tailscale interface only (SEC-005)
8. **Error sanitization:** Never return raw tmux/shell stderr to WebSocket clients (SEC-008)
9. **Input limits:** Max 4096 char command length, existing rate limits preserved (10 cmd/min)

---

## Testing Strategy

**[DEEPENED] New section — addresses ARCH-009**

### Unit Tests (mock tmux)

| Test | What |
|------|------|
| Adapter selection | `process.platform === 'linux'` → linux-tmux adapter |
| Pane ID validation | `%0` ✓, `%999` ✓, `%foo` ✗, `; rm -rf` ✗ |
| Command sanitization | Null bytes stripped, control chars stripped, length enforced |
| `execFile` argument construction | Verify no shell interpolation possible |
| Discovery parsing | Parse `tmux list-panes` format output → session objects |
| Self-exclusion | Server pane filtered from results |
| Failure modes | tmux not running → empty list + error message, pane dead → error |

### Integration Tests (require tmux)

| Test | What |
|------|------|
| `send-keys -l` round-trip | Create tmux pane, inject text, capture output, verify |
| Special characters | Inject `$()`, backticks, semicolons — verify literal delivery |
| Escape + Ctrl+U prep | Verify prep clears input line without side effects |
| Session discovery | Start Claude in tmux, verify discovery returns correct pane |
| Pane mutex | Send 3 commands rapidly, verify serialized delivery |

---

## Open Questions

**[DEEPENED] Retained from review — decisions deferred to implementation**

1. **Config externalization:** Should platform, tmux socket path, and listen host be in `.env` or a separate config file? (ARCH-008)
2. **Token rotation:** Document rotation procedure now or defer? (SEC-007 — LOW priority, existing limitation)
3. **Multi-client conflict:** If two phones approve/deny the same permission simultaneously, who wins? (FLOW-014 — existing limitation on macOS too)
4. **Onboarding:** Add first-use help screen on phone, or out of scope for port? (FLOW-013)

---

## Enhancement Summary

**Status:** `DEEPENED_READY_FOR_REVIEW`

| Metric | Count |
|--------|-------|
| Research agents | 3 (codebase, learnings, best practices) |
| Review agents | 6 (architecture, simplicity, security, performance, edge case, spec-flow) |
| Total findings | 53 across all agents |
| CRITICAL findings | 5 (injection sanitization ×3, platform abstraction, PID mismatch) |
| HIGH findings | 17 |
| MEDIUM findings | 18 |
| LOW findings | 13 |

### Priority Fixes Applied to Plan

1. **Platform adapter pattern** — Converts destructive fork into additive port (ARCH-001, ARCH-004)
2. **tmux as sole discovery source** — Eliminates ps+grep+lsof fragility (SIMP-001, ARCH-003, PERF-001)
3. **`execFile` + `-l` flag** — Closes shell injection attack surface (SEC-001, EC-003, EC-014)
4. **Pane ID as session identity** — Stable across Claude restarts (ARCH-006, EC-008)
5. **HTTPS required** — Secure token transport over Tailscale (SEC-002)
6. **Failure mode specifications** — Every tmux failure has defined behavior (ARCH-002, EC-005, FLOW-001)
7. **Server self-exclusion** — `$TMUX_PANE` prevents self-injection (EC-009)
8. **Per-pane mutex** — Prevents command interleaving (EC-007)
9. **Removed AppleScript delay constants** — 1.7s → 150ms for injection prep (PERF-005)
10. **inotify over polling** — Leverages Linux kernel events (PERF-002)

### Learnings Applied

- Session discovery via JSONL filesystem scan is platform-agnostic (reuse as-is)
- AppleScript clipboard race condition disappears on Linux (tmux send-keys is atomic)
- TTY detection via `tmux list-panes -F "#{pane_tty}"` returns pts device, no regex needed
- `tmux send-keys -l` (literal) is critical — without it, key name interpretation creates injection vectors
