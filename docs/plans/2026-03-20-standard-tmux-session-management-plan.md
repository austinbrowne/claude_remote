---
title: tmux Session Management from Mobile
status: approved
tier: standard
created: 2026-03-20
tags: [feature, tmux, web, session-management]
---

# tmux Session Management from Mobile

## Problem

Users can't create new Claude sessions or terminal panes from the mobile app. To start work in a new repo, they must SSH into the Mac Mini. The session browser is read-only — it only shows existing sessions.

## Goals

1. Create new tmux terminal windows from the session browser (web first, iOS follow-up)
2. Start a Claude session (`claude --resume --effort high`) in any terminal pane from within the app
3. Configure a git repos folder and pick repos to start new Claude sessions in
4. All new Claude sessions default to `--effort high`

## Solution

**Server:** New `lib/terminal-manager.js` module with 3 actions. `list_repos` exposed as HTTP GET, `new_terminal` and `start_claude` as WebSocket actions.

**Web:** Add buttons to session browser and terminal pane view. iOS is a follow-up plan — the mobile web app already works on iOS.

## Technical Approach

### Architecture

New `lib/terminal-manager.js` module owns all session management logic. `server.js` dispatches WebSocket messages and HTTP routes to this module. Follows the existing pattern of `lib/platform/` for platform-specific logic.

### Server API

**`GET /repos`** (HTTP) — Lists repo names from configured path:
```javascript
// Returns names only — never expose server filesystem paths to client
router.get('/repos', authenticate, async (req, res) => {
  const reposPath = process.env.REPOS_PATH;
  if (!reposPath) return res.status(500).json({ error: 'REPOS_PATH not configured' });
  const entries = await fsp.readdir(reposPath, { withFileTypes: true });
  const repos = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const hasGit = await fsp.access(path.join(reposPath, e.name, '.git')).then(() => true).catch(() => false);
    if (hasGit) repos.push({ name: e.name });
  }
  res.json({ repos });
});
```

**`new_terminal`** (WebSocket) — Creates a tmux window. Accepts a `repoName` (not a path) — resolved server-side against `REPOS_PATH`:
```javascript
case 'new_terminal': {
  // Input validation
  if (msg.repoName && typeof msg.repoName !== 'string') { sendError(...); break; }

  // Resolve CWD: repo name → full path (server-side only, never from client path)
  let targetDir = process.env.HOME;
  if (msg.repoName) {
    const resolved = path.resolve(process.env.REPOS_PATH, msg.repoName);
    if (!resolved.startsWith(process.env.REPOS_PATH)) { sendError('Invalid repo'); break; }
    targetDir = resolved;
  }

  await terminalManager.createWindow('claude', targetDir);
  broadcastSessionList();
}
```

**`start_claude`** (WebSocket) — Starts Claude in a terminal pane:
```javascript
case 'start_claude': {
  if (typeof msg.sessionId !== 'string') { sendError(...); break; }
  const sd = activeSessions.get(msg.sessionId);
  if (!sd?.session?.isTerminal) { sendError('Not a terminal pane'); break; }

  await injectCommandToTty('claude --resume --effort high', sd.session.tty);

  // Event-driven: watch for JSONL file to appear, emit session_ready
  // Hard timeout: 10s → emit error to client
  terminalManager.awaitClaudeStart(msg.sessionId, sd.session.cwd, {
    onReady: () => broadcastSessionList(),
    onTimeout: () => ws.send(JSON.stringify({
      type: 'start_claude_result', success: false, error: 'Claude did not start within 10s'
    }))
  });
}
```

### Security: Path Traversal Prevention

- `list_repos` returns **names only** — never full paths
- `new_terminal` accepts a **repo name** — resolved server-side with `path.resolve()` + `startsWith(REPOS_PATH)` check
- Client never sends filesystem paths to server
- All inputs type-checked before use

### Rate Limiting

- `new_terminal`: max 5 per minute per client
- `start_claude`: max 1 per 5 seconds per client
- Enforced server-side alongside existing rate limits

### Session Start: Event-Driven (Not Magic Delay)

After `start_claude`, instead of a 3s delay:
1. Watch for a new JSONL file in `~/.claude/projects/` matching the pane's CWD
2. When found → broadcast updated session list (pane transitions from terminal to Claude)
3. Hard timeout at 10s → send `start_claude_result { success: false }` to client
4. Client clears spinner and shows error toast on failure

### `REPOS_PATH` Config

Stored in `.env`. Validated at server startup:
- Must be set explicitly (no silent default)
- Must be an existing directory
- Warning logged if not set: `[Config] REPOS_PATH not set — repo picker disabled`

### Web UI Changes

**Session drawer (`sessions.js`):**
- "New Terminal" button at bottom of session list (disabled during creation, spinner on tap, re-enabled on success/error)
- "New Claude Session" button → fetches `GET /repos` → shows repo picker modal
- Double-tap guard: button disabled after first tap until response

**Terminal pane view (`ui.js`):**
- "Start Claude" button shown in input area when session status is `terminal`
- Button shows spinner during launch, disabled state
- On success: session transitions, button disappears (no longer terminal)
- On failure (10s timeout): spinner clears, button re-enables, error toast

**Repo picker modal:**
- Fetches `GET /repos` on open
- Shows list of repo names
- "No repos found — configure REPOS_PATH in .env" for empty state
- "Repos not configured — set REPOS_PATH in server .env" for missing config
- Spinner on tapped row during creation
- Picker stays open on failure, row re-enables for retry
- Dismiss cancels in-flight request (late response ignored)

### `--resume` Semantics

`claude --resume --effort high` behavior:
- If prior session exists in CWD: resumes it
- If no prior session: starts a new one (Claude CLI fallback behavior)
- This is correct for both cases — no special handling needed

## Implementation Steps

1. **Add `REPOS_PATH` to `.env`** — validate at startup, warn if missing
2. **Create `lib/terminal-manager.js`** — `createWindow()`, `startClaude()`, `awaitClaudeStart()`, `listRepos()`
3. **Add `GET /repos` HTTP endpoint** — returns repo names only, requires Bearer auth
4. **Add `new_terminal` WS action** — accepts `repoName` (not path), resolves server-side, rate-limited
5. **Add `start_claude` WS action** — validates isTerminal, injects command, event-driven JSONL watch with 10s timeout
6. **Add error handling** — try/catch all handlers, generic errors to client, full errors to server log
7. **Web: Session drawer buttons** — "New Terminal" + "New Claude Session" with loading states and double-tap guard
8. **Web: "Start Claude" button** — shown for terminal panes, spinner + timeout + error toast
9. **Web: Repo picker modal** — fetch repos, select, create + launch, stay open on failure

## Affected Files

| File | Change |
|------|--------|
| `.env` | Add `REPOS_PATH=/Users/dazz/Git_Repos` |
| `lib/terminal-manager.js` | **New** — createWindow, startClaude, awaitClaudeStart, listRepos |
| `server.js` | Route WS actions to terminal-manager, add GET /repos endpoint |
| `lib/platform/linux-tmux.js` | Add `createWindow(sessionName, cwd)` helper |
| `public/js/sessions.js` | Buttons in session drawer, repo picker modal |
| `public/js/ui.js` | "Start Claude" button for terminal panes |
| `public/js/connection.js` | Handle `start_claude_result` message |
| `public/index.html` | Repo picker modal markup |

iOS follow-up: `ContentView.swift`, `InputBarView.swift`, `RepoPickerView.swift`, `WebSocketMessage.swift`, `AppCoordinator.swift` — separate plan after web is validated.

## Spec-Flow Analysis

### Flow 1: New Terminal
Tap "New Terminal" → button disabled + spinner → server creates tmux window → broadcasts session list → new pane appears → auto-switch to it.
- **Error:** tmux not running → toast "tmux server not available", button re-enables.
- **Error:** window creation fails → toast with generic error, button re-enables.
- **Double-tap:** button disabled during operation, re-enabled on response.

### Flow 2: Start Claude in terminal pane
Viewing terminal → tap "Start Claude" → button disabled + spinner → server injects `claude --resume --effort high` → server watches for JSONL → session transitions to Claude type → log streaming begins → button disappears.
- **Timeout (10s):** spinner clears, button re-enables, toast "Claude did not start — check terminal output".
- **Error:** pane is no longer terminal → server returns error, toast "Session is no longer a terminal".
- **`--resume` on fresh pane:** starts new session (Claude CLI fallback).

### Flow 3: New Claude Session from repo picker
Tap "New Claude Session" → `GET /repos` → picker shown → tap repo → row spinner → server creates tmux window in repo dir → starts Claude → JSONL watch → session appears in list.
- **Error (window creation):** picker stays open, row spinner clears, row re-enables, toast with error.
- **Error (Claude start):** window created but Claude didn't start within 10s → session appears as terminal pane, toast "Claude did not start".
- **Empty:** no repos → "No repos found. Configure REPOS_PATH in your server's .env file."
- **Not configured:** REPOS_PATH missing → "Repos not configured. Set REPOS_PATH in server .env."
- **Dismiss during load:** late response ignored, no state mutation.

## Acceptance Criteria

### Web
- [ ] "New Terminal" button in session drawer creates a tmux window that appears in session list
- [ ] "New Terminal" button disabled during creation with spinner, re-enables on success/error
- [ ] Terminal panes show "Start Claude" button in input area
- [ ] "Start Claude" runs `claude --resume --effort high`, session transitions to Claude type within 10s
- [ ] "Start Claude" shows spinner, clears on success or 10s timeout with error toast
- [ ] "New Claude Session" fetches repo list and shows picker modal
- [ ] Selecting a repo creates tmux window cd'd to repo and starts Claude
- [ ] Repo picker shows "not configured" / "no repos" states appropriately
- [ ] All new Claude sessions use `--effort high`
- [ ] `REPOS_PATH` configurable in `.env`, validated at startup

### Security
- [ ] `new_terminal` accepts repo name only — never a client-supplied path
- [ ] Path traversal (`../`) rejected by `startsWith(REPOS_PATH)` check
- [ ] `list_repos` returns names only, no filesystem paths
- [ ] Rate limiting: max 5 terminals/min, max 1 start_claude/5s
- [ ] All WS inputs type-validated before use

### iOS (Follow-up plan)
- [ ] Same functionality ported to native iOS after web is validated

## Risks

| Risk | Mitigation |
|------|------------|
| Path traversal via `repoName` | Resolve server-side, validate `startsWith(REPOS_PATH)` |
| Unbounded tmux window creation | Rate limit 5/min + client-side double-tap guard |
| Claude doesn't start (binary missing, auth issue) | 10s timeout with error to client, pane remains as terminal |
| `start_claude` on non-terminal | Server validates `isTerminal`, returns typed error |
| JSONL never appears after start | Hard 10s timeout, event-driven watch (not polling delay) |
| `REPOS_PATH` misconfigured | Validated at startup, distinct error for "not set" vs "empty" |
| tmux session `claude` doesn't exist | `createWindow` creates session if missing |

## Test Strategy

1. Unit test: `createWindow` calls tmux with correct args, handles missing session
2. Unit test: `startClaude` rejects non-terminal sessions, validates input types
3. Unit test: `listRepos` returns names only, handles missing path, filters non-git dirs
4. Unit test: path traversal rejected (`../` in repoName)
5. Unit test: rate limiting enforced on `new_terminal` and `start_claude`
6. Integration: `awaitClaudeStart` detects JSONL file appearance, respects timeout
7. Manual: create terminal from web, start Claude, verify full transition
8. Manual: create Claude session from repo picker, verify log streaming starts
9. Manual: test timeout — start Claude with binary not in PATH, verify error toast at 10s
10. Manual: test double-tap — rapid "New Terminal" taps, verify only one created
