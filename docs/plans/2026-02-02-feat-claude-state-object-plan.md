---
title: "feat: Introduce claudeState Server-to-Client State Sync"
type: feat
date: 2026-02-02
---

# Introduce `claudeState` Server-to-Client State Sync

## Overview

Replace the current fragmented state broadcasting (individual `session_status`, `context_percentage`, `mode_change` messages) with a unified `claudeState` object that the server assembles and pushes to clients. This object becomes the single source of truth for all session-level state, including **allowed tools** — fixing the broken "always allow" permission filtering.

## Problem Statement

### Immediate Bug: "Always Allow" Doesn't Stick

When a user taps "Always" on a permission prompt:
1. iOS `cascadeAlwaysAllow()` clears currently-queued permissions for that tool — but only the current queue
2. Server's batch filter catches auto-approved permissions only when `permission_request` + `tool_result` appear in the same file-watcher read — timing-dependent
3. Web UI populates `alwaysAllowedTools` Set but **never reads it** — dead code
4. **No persistent tracking anywhere.** Reconnecting, switching sessions, or a file-watcher timing miss causes prompts to leak through

### Structural Problem: Fragmented State

The server currently broadcasts 6+ individual message types for session state:
- `session_status` (idle/waiting/processing)
- `context_percentage` (0-100)
- `mode_change` (default/plan/acceptEdits)
- `subagent_start/stop/tool/tokens` (per-agent)
- `task_create/update/list`

Each client independently tracks and reconciles these. State diverges between web and iOS. Reconnecting clients get an ad-hoc sequence of catch-up messages (`watching` → `session_status` → history → subagents → `context_percentage`). There's no single "here's the full picture" message.

### What Claude Code Already Knows

Claude Code maintains its own permission state in:
- **User-level**: `~/.claude/settings.local.json` → `permissions.allow[]` (e.g. `"WebFetch(domain:github.com)"`)
- **Project-level**: `~/.claude/projects/<hash>/settings.local.json` → `permissions.allow[]`
- **Session-level**: JSONL log records `permissionMode` on user entries (tracks mode: `default`, `plan`, `acceptEdits`)
- **Per-tool auto-approve**: When user says "always" in terminal, Claude Code auto-approves future calls — visible as permission_request + immediate tool_result pairs in the JSONL

Our server is blind to all of this. It hardcodes `PERMISSION_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'NotebookEdit']` and emits `permission_request` for all of them regardless of what Claude Code already allows.

## Proposed Solution

### The `claudeState` Object

A unified state object assembled server-side, broadcast on change, and sent in full on session watch:

```javascript
{
  type: 'claude_state',
  sessionId: 'abc-123',
  state: {
    // Session identity
    session: {
      id: 'abc-123',
      name: 'claude_remote',
      cwd: '/Users/austin/Git_Repos/claude_remote',
      branch: 'main',
      tty: '/dev/ttys004',
      pid: 12345
    },

    // Session status
    status: 'waiting',              // idle | waiting | processing | active
    mode: 'default',                // default | plan | acceptEdits
    contextPercentage: 42,          // 0-100, from /tmp/claude-ctx-{sessionId}

    // Permissions — the key addition
    permissions: {
      // Tools the server knows are pre-allowed (from settings files + session grants)
      allowedTools: [
        'Read', 'Glob', 'Grep', 'LS',           // Always allowed by Claude Code
        'WebSearch',                              // From ~/.claude/settings.local.json
        'WebFetch(domain:github.com)',            // Domain-scoped allows
        'mcp__plugin_compound-engineering_context7__resolve-library-id',
        'mcp__plugin_compound-engineering_context7__query-docs'
      ],
      // Tools granted "always" during this session (tracked by server when it injects "always")
      sessionGranted: ['Bash', 'Edit', 'Write'],
      // The raw permission mode from JSONL
      mode: 'default'
    },

    // Active subagents
    subagents: {
      'agent-abc': {
        status: 'running',
        description: 'Exploring codebase',
        agentType: 'Explore',
        currentTool: 'Grep',
        inputTokens: 1200,
        outputTokens: 800,
        startTime: '2026-02-02T20:00:00Z',
        lastActivity: '2026-02-02T20:01:30Z'
      }
    },

    // Active tasks
    tasks: [
      { id: '1', subject: 'Fix auth', status: 'in_progress', activeForm: 'Fixing auth' },
      { id: '2', subject: 'Add tests', status: 'pending', activeForm: 'Adding tests' }
    ],

    // Timestamps
    lastActivity: '2026-02-02T20:01:30Z',
    watchingSince: '2026-02-02T19:55:00Z'
  }
}
```

### How Permissions Work

**On session watch (initial connect):**
1. Server reads `~/.claude/settings.local.json` → `permissions.allow[]`
2. Server reads project-level `settings.local.json` if it exists → `permissions.allow[]`
3. Server merges both into `allowedTools`
4. Server adds Claude Code's always-free tools: `Read`, `Glob`, `Grep`, `LS`, `TodoRead`, `Task`, `WebSearch` (these never require permission)
5. Server sends full `claudeState` including `permissions.allowedTools`

**On "always" response from client:**
1. Client sends inject command `"always"` (unchanged)
2. Server intercepts: before injecting, it records the tool name in `sessionData.sessionGranted` Set
3. Server broadcasts updated `claudeState` with the tool added to `permissions.sessionGranted`
4. All clients immediately know this tool is now allowed

**On permission_request parsing:**
1. `parseLogEntry()` checks if the tool is in `allowedTools` OR `sessionGranted`
2. If yes: **don't emit `permission_request`** at all — tool is pre-allowed
3. If no: emit as before
4. Batch co-occurrence filter remains as a safety net but is no longer the primary mechanism

**On client (iOS):**
1. `PromptService` receives `claudeState` and maintains a local `allowedTools` Set
2. Before showing any permission prompt, checks `allowedTools` — if tool is there, auto-dismiss
3. On reconnect: full `claudeState` restores the Set immediately

### Broadcast Strategy

**Full state on:**
- Initial `watch_session` (replaces the ad-hoc catch-up sequence)
- Reconnection

**Delta broadcasts (existing messages continue for now):**
- Individual `session_status`, `context_percentage`, `mode_change` messages continue as-is for low-latency updates
- Server also updates `sessionData.claudeState` on each change
- `claudeState` is the authoritative snapshot; individual messages are optimistic updates

**Periodic sync (safety net):**
- Every 30 seconds, server sends full `claudeState` to all watching clients
- Corrects any drift from missed individual messages
- Low overhead — one JSON object per session per 30s

## Technical Approach

### Server Changes (`server.js`)

#### 1. New: `buildClaudeState(sessionId)` function

Assembles the full state object from `sessionData` + settings files.

```javascript
function buildClaudeState(sessionId) {
  const sd = activeSessions.get(sessionId);
  if (!sd) return null;

  return {
    session: {
      id: sessionId,
      name: sd.session.name,
      cwd: sd.session.cwd,
      branch: sd.session.branch,
      tty: sd.session.tty,
      pid: sd.session.pid
    },
    status: sd.lastStatus || 'unknown',
    mode: sd.mode || 'default',
    contextPercentage: sd.contextPercentage || 0,
    permissions: {
      allowedTools: Array.from(sd.allowedTools || []),
      sessionGranted: Array.from(sd.sessionGranted || []),
      mode: sd.mode || 'default'
    },
    subagents: Object.fromEntries(
      Array.from(sd.subagentInfo.entries()).map(([id, info]) => [id, { ...info }])
    ),
    tasks: sd.tasks || [],
    lastActivity: sd.lastActivity || new Date().toISOString(),
    watchingSince: sd.watchingSince || new Date().toISOString()
  };
}
```

#### 2. New: `loadAllowedTools(sessionCwd)` function

Reads Claude Code's settings files on session discovery:

```javascript
async function loadAllowedTools(sessionCwd) {
  const allowed = new Set([
    // Claude Code built-in always-allowed tools
    'Read', 'Glob', 'Grep', 'LS', 'TodoRead', 'TaskCreate', 'TaskUpdate',
    'TaskGet', 'TaskList', 'WebSearch'
  ]);

  // User-level: ~/.claude/settings.local.json
  try {
    const userSettings = JSON.parse(
      await fsp.readFile(path.join(CLAUDE_DIR, 'settings.local.json'), 'utf8')
    );
    (userSettings.permissions?.allow || []).forEach(t => allowed.add(t));
  } catch { /* no user settings */ }

  // Project-level: ~/.claude/projects/<hash>/settings.local.json
  if (sessionCwd) {
    const projectHash = sessionCwd.replace(/\//g, '-');
    try {
      const projSettings = JSON.parse(
        await fsp.readFile(path.join(CLAUDE_DIR, 'projects', projectHash, 'settings.local.json'), 'utf8')
      );
      (projSettings.permissions?.allow || []).forEach(t => allowed.add(t));
    } catch { /* no project settings */ }
  }

  return allowed;
}
```

#### 3. Update: `watchSession()` — load allowed tools on watch

When a session is first watched, call `loadAllowedTools(session.cwd)` and store the result on `sessionData`.

#### 4. Update: `parseLogEntry()` — skip allowed tools

Replace the hardcoded `PERMISSION_TOOLS` check with an allowed-tools check:

```javascript
// Before:
else if (PERMISSION_TOOLS.includes(block.name) || isMcpTool) {
  // Always emit permission_request
}

// After:
else if (needsPermission(block.name, sessionData)) {
  // Only emit if tool is NOT in allowedTools or sessionGranted
}
```

New helper:
```javascript
function needsPermission(toolName, sessionData) {
  if (!sessionData) return true;
  const allowed = sessionData.allowedTools || new Set();
  const granted = sessionData.sessionGranted || new Set();

  // Exact match
  if (allowed.has(toolName) || granted.has(toolName)) return false;

  // Domain-scoped match for WebFetch: "WebFetch(domain:github.com)"
  // Check if any allowed entry matches WebFetch with matching domain
  if (toolName === 'WebFetch') {
    for (const entry of allowed) {
      if (entry.startsWith('WebFetch(')) return false;
    }
  }

  // MCP tools: check both full name and base name
  if (toolName.startsWith('mcp__')) {
    if (allowed.has(toolName)) return false;
  }

  // Default: needs permission
  return true;
}
```

#### 5. Update: `inject` handler — track "always" grants

When the server injects `"always"` to iTerm, record the tool:

```javascript
case 'inject': {
  // Track "always" grants
  if (msg.command === 'always' && msg.sessionId) {
    const sd = activeSessions.get(msg.sessionId);
    if (sd && sd.lastPermissionTool) {
      sd.sessionGranted.add(sd.lastPermissionTool);
      broadcastClaudeState(msg.sessionId);
    }
  }
  // ... existing inject logic
}
```

Track the tool from the most recent `permission_request`:
```javascript
// In parseLogEntry, when emitting permission_request:
if (sessionData) sessionData.lastPermissionTool = block.name;
```

#### 6. Update: `watch_session` handler — send claudeState

Replace the ad-hoc catch-up sequence with a single `claude_state` message after history:

```javascript
// After sendRecentHistory + sendActiveSubagents:
ws.send(JSON.stringify({
  type: 'claude_state',
  sessionId: msg.sessionId,
  state: buildClaudeState(msg.sessionId)
}));
```

Keep the individual `session_status` and `context_percentage` sends for backwards compat during rollout.

#### 7. New: Periodic sync interval

```javascript
// Every 30 seconds, broadcast full state to all watching clients
setInterval(() => {
  for (const [sessionId] of activeSessions) {
    broadcastToClients({
      type: 'claude_state',
      sessionId,
      state: buildClaudeState(sessionId)
    });
  }
}, 30000);
```

### iOS Changes

#### 1. New: `ClaudeState` model

```swift
public struct ClaudeState: Decodable, Sendable {
    public let session: SessionInfo?
    public let status: String?
    public let mode: String?
    public let contextPercentage: Double?
    public let permissions: Permissions?
    public let subagents: [String: SubagentInfo]?
    public let tasks: [TaskItem]?
    public let lastActivity: String?

    public struct SessionInfo: Decodable, Sendable {
        public let id: String?
        public let name: String?
        public let cwd: String?
        public let branch: String?
    }

    public struct Permissions: Decodable, Sendable {
        public let allowedTools: [String]?
        public let sessionGranted: [String]?
        public let mode: String?
    }
}
```

#### 2. Update: `WebSocketMessage` — decode `claude_state`

Add a new case and decode the nested state object.

#### 3. Update: `AppCoordinator` — handle `claude_state`

```swift
case .claudeState(let sessionId, let claudeState):
    guard sessionId == state.currentSessionId else { return }
    // Apply all state atomically
    if let status = claudeState.status {
        state.sessionStatus = SessionStatus(rawValue: status) ?? .unknown
    }
    if let mode = claudeState.mode {
        state.sessionMode = SessionMode(rawValue: mode) ?? .defaultMode
    }
    if let pct = claudeState.contextPercentage {
        state.contextPercentage = pct
    }
    if let permissions = claudeState.permissions {
        promptService.updateAllowedTools(permissions)
    }
    // ... subagents, tasks
```

#### 4. Update: `PromptService` — filter with allowed tools

```swift
// New property
private var allowedTools: Set<String> = []

public func updateAllowedTools(_ permissions: ClaudeState.Permissions) {
    var tools = Set(permissions.allowedTools ?? [])
    tools.formUnion(permissions.sessionGranted ?? [])
    allowedTools = tools
}

// In permission handling — before enqueuing:
private func isToolAllowed(_ tool: String) -> Bool {
    if allowedTools.contains(tool) { return true }
    // Domain-scoped: WebFetch(domain:x.com) allows WebFetch
    if tool == "WebFetch" {
        return allowedTools.contains(where: { $0.hasPrefix("WebFetch(") })
    }
    // MCP tools
    if tool.hasPrefix("mcp__") {
        return allowedTools.contains(tool)
    }
    return false
}
```

When a `permission_request` arrives and `isToolAllowed(tool)` returns true, skip it entirely.

### Web UI Changes

#### Update: `prompts.js` — use `alwaysAllowedTools` for real

```javascript
// On claude_state message:
if (msg.data.type === 'claude_state') {
  const perms = msg.data.state?.permissions;
  if (perms) {
    alwaysAllowedTools.clear();
    (perms.allowedTools || []).forEach(t => alwaysAllowedTools.add(t));
    (perms.sessionGranted || []).forEach(t => alwaysAllowedTools.add(t));
  }
}

// Before showing permission card — check:
if (alwaysAllowedTools.has(tool)) {
  return; // Don't show
}
```

## Acceptance Criteria

### Functional Requirements

- [ ] Server reads `~/.claude/settings.local.json` and project-level settings on session watch
- [ ] Server tracks "always" grants per session when injecting commands
- [ ] Server skips emitting `permission_request` for tools in `allowedTools` or `sessionGranted`
- [ ] Server sends full `claude_state` on initial watch and periodically (30s)
- [ ] iOS decodes `claude_state` and applies all fields atomically
- [ ] iOS `PromptService` filters incoming permissions against `allowedTools`
- [ ] Web UI uses `alwaysAllowedTools` to filter permission cards (currently dead code)
- [ ] `cascadeAlwaysAllow` on iOS still works for in-flight queue cleanup
- [ ] Batch co-occurrence filter remains as safety net in `parseLogEntry`

### Non-Functional Requirements

- [ ] Reconnecting clients receive full state within first message exchange
- [ ] No permission prompt flicker on tools that are already allowed
- [ ] Backwards compatible: existing individual messages (`session_status`, etc.) still sent
- [ ] Settings file reads are cached (not re-read on every state build)

### Quality Gates

- [ ] All existing 379+ tests still pass
- [ ] New tests for `buildClaudeState()`, `loadAllowedTools()`, `needsPermission()`
- [ ] New tests for iOS `ClaudeState` decoding and `isToolAllowed()` filtering
- [ ] Manual test: tap "Always" → no more prompts for that tool across reconnects

## Files Modified

| File | Change |
|------|--------|
| `server.js` | `buildClaudeState()`, `loadAllowedTools()`, `needsPermission()`, inject tracking, periodic sync, watch_session update |
| `ClaudeRemote/.../Models/ClaudeState.swift` | NEW — `ClaudeState` Decodable struct |
| `ClaudeRemote/.../Models/WebSocketMessage.swift` | Add `.claudeState` case + decoder |
| `ClaudeRemote/.../Models/AppState.swift` | (possibly) add `allowedTools` if needed at state level |
| `ClaudeRemote/.../Services/AppCoordinator.swift` | Handle `.claudeState` message |
| `ClaudeRemote/.../Services/PromptService.swift` | `updateAllowedTools()`, `isToolAllowed()`, filter in permission handling |
| `public/js/prompts.js` | Handle `claude_state` message, use `alwaysAllowedTools` for filtering |

## Dependencies & Risks

### Risks

1. **Settings file format changes**: Claude Code could change `settings.local.json` structure. Mitigation: defensive parsing with fallbacks.
2. **Domain-scoped matching**: `WebFetch(domain:github.com)` needs pattern matching, not exact string match. The `needsPermission()` helper handles this but needs thorough testing.
3. **Stale settings cache**: If user changes permissions mid-session via `/permissions` command, the server won't know. Mitigation: re-read on periodic sync (every 30s) or watch the settings files.
4. **Session-granted tools aren't persisted**: If server restarts, `sessionGranted` Set is lost. This is acceptable — Claude Code itself maintains the persistent state, so the batch filter catches it.

### What NOT to Do (from institutional learnings)

- **Don't cache session indexes** — always scan JSONL files directly
- **Don't drop subagent permissions** — route `subagent_output` permission_requests to PromptService
- **Don't use dictionaries for ordered queues** — use arrays with monotonic counters
- **Don't skip `guard !Task.isCancelled` after `try? await`** — tasks continue after cancel otherwise
- **Don't use `os.tmpdir()` for `/tmp` paths** — macOS returns `/var/folders/.../T`

## Future Considerations

- **File watchers on settings files**: Instead of periodic re-reads, watch `settings.local.json` for changes and update `allowedTools` in real-time
- **Bidirectional state**: Client could send `claudeState` requests (e.g., "grant Bash always") and server applies + broadcasts
- **State diffing**: Instead of sending full state every 30s, compute and send only changed fields
- **Model tracking**: Add `model` field to `claudeState` (currently not tracked — would need JSONL parsing or API call)

## References

### Internal

- `server.js:970` — Hardcoded `PERMISSION_TOOLS` array (to be replaced)
- `server.js:441-453` — Batch co-occurrence filter (to remain as safety net)
- `server.js:1558-1566` — Existing `get_state` handler (minimal, to be expanded)
- `PromptService.swift:430-442` — `cascadeAlwaysAllow()` (keep, augment with allowedTools)
- `public/js/prompts.js:290` — Dead `alwaysAllowedTools` Set (to be activated)
- `~/.claude/settings.local.json` — User-level permissions
- `AppState.swift:61-129` — Current iOS state shape

### Institutional Learnings

- `docs/solutions/integration-issues/claude-code-remote-monitoring.md` — Permission card timing, 500ms delay pattern
- `docs/solutions/concurrency-issues/permission-queue-concurrent-subagents.md` — FIFO queue, cascade, subagent routing
- `docs/solutions/code-quality/phase-8-review-fixes-race-security-perf.md` — Broadcast pause during history, session switch race
- `docs/solutions/logic-errors/swift-structured-concurrency-pitfalls-observable-classes.md` — Task cancellation, retain cycles
