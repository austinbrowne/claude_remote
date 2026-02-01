---
title: "Parallel Swarm Fix for Multi-Agent Code Review Findings"
date: 2026-01-31
category: logic-errors
tags: [code-review, parallel-agents, swarm-fix, websocket, swift, nodejs, security-hardening, resource-leaks, session-filtering]
severity: critical
module: [server.js, AppCoordinator.swift, WebSocketMessage.swift]
symptoms:
  - Variable shadowing causing stale session data in history delivery
  - Cross-session message leaks in iOS client
  - File handle leaks on read errors
  - pauseBroadcast stuck true on error leaving client in limbo
  - AppleScript injection via malformed TTY or control characters
  - Legacy URL token auth exposing credentials in browser history
  - Redundant polling doubling CPU usage
  - Missing sessionId format validation
resolved: true
---

# Parallel Swarm Fix for Multi-Agent Code Review Findings

## Problem

After an 8-agent parallel code review of ClaudeRemote (iOS app + Node.js server, 37 commits, 68 files, 12,884 insertions vs main), **27 findings** were identified across security, performance, architecture, patterns, agent-native design, simplicity, data integrity, and JS/Node review.

14 P1/P2 findings required fixing across 3 source files. The challenge: apply all fixes simultaneously without edit conflicts, with minimal context window usage.

### Symptoms

- **P1 Variable Shadowing**: `sendRecentHistory` had `const sessionData` declared twice — the second (line 1477) shadowed the first (line 1413), causing subsequent code to reference stale data after the re-declaration.
- **P1 Cross-Session Leaks**: `.claudeOutput` handler in AppCoordinator did not filter by sessionId. Output from session B would appear in session A's chat.
- **P1 pauseBroadcast Stuck**: If `sendRecentHistory` threw an error, `clientData.pauseBroadcast` was never reset to `false`, permanently silencing the client.
- **P1 File Handle Leaks**: 4 sites called `fsp.open()` without try/finally, leaking file descriptors on read errors.
- **P2 AppleScript Injection**: TTY parameter not validated (path traversal possible), null bytes and control characters not stripped.
- **P2 Legacy Auth**: URL query string `?token=xxx` still accepted, exposing tokens in browser history and server logs.

## Root Cause

The codebase grew rapidly (37 commits in the iOS feature branch) with patterns that worked for the happy path but lacked defensive coding:

1. **No try/finally discipline** on resource acquisition (file handles, state flags)
2. **No sessionId filtering** on the highest-volume message handler (`claudeOutput`)
3. **Legacy code paths** left as fallbacks rather than being removed
4. **Missing input validation** on user-supplied identifiers before use in file operations or shell commands

## Solution

### Approach: Swarm Fix

Fixes were grouped by **file ownership** to enable parallel execution without edit conflicts:

| Agent | Files | Fixes |
|-------|-------|-------|
| Agent A | `server.js` | 10 fixes (shadowing, try/finally, AppleScript, auth, polling, validation, shutdown) |
| Agent B | `AppCoordinator.swift` | 1 fix (sessionId filtering) |
| Agent C | `WebSocketMessage.swift` | 1 fix (status_update decoder field) |

All 3 agents launched in a single message with exact edit instructions. Total parallel execution time was bounded by the slowest agent (server.js with 10 edits).

### Fixes Applied

**server.js (10 fixes)**

1. **Variable shadowing** — Removed duplicate `const sessionData` at line 1477 (already declared at line 1413).

2. **pauseBroadcast try/finally** — Wrapped `sendRecentHistory` + `sendActiveSubagents` in try/finally with block scoping:
```javascript
case 'watch_session': {
  clientData.pauseBroadcast = true;
  try {
    await sendRecentHistory(ws, msg.sessionId);
    await sendActiveSubagents(ws, msg.sessionId);
  } finally {
    clientData.pauseBroadcast = false;
  }
}
```

3. **File handle leaks** — All 4 `fsp.open()` sites now use try/finally:
```javascript
const fh = await fsp.open(filePath, 'r');
const buffer = Buffer.alloc(bytesToRead);
try {
  await fh.read(buffer, 0, bytesToRead, position);
} finally {
  await fh.close();
}
```

4. **AppleScript hardening** — TTY validation + control character stripping:
```javascript
if (!/^ttys\d+$/.test(tty)) {
  return Promise.reject(new Error('Invalid TTY format'));
}
const sanitized = command.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
```

5. **Legacy URL auth removed** — Deleted URL token parsing and auto-auth block. All auth via message-based `auth` action only.

6. **getSessionStatus optimization** — Added `linesProcessed` flag; status check only runs when valid JSON lines were parsed.

7. **Redundant poll removed** — Deleted 2-second `setInterval` fallback (chokidar 500ms polling already sufficient).

8. **discoverSessions cache** — Moved `activeSessions.has()` check above `discoverSessions()` call.

9. **SessionId validation** — Added at top of `handleClientMessage`:
```javascript
if (!/^[a-f0-9-]+$/.test(msg.sessionId) || msg.sessionId.length > 100) {
  sendError(ws, 'INVALID_SESSION_ID', 'Invalid session ID format');
  return;
}
```

10. **Shutdown cleanup** — Replaced manual forEach with `unwatchSession()` loop for complete cleanup (subagent watchers, timeouts, poll intervals).

**AppCoordinator.swift (1 fix)**

11. **SessionId filtering** on `.claudeOutput`:
```swift
case .claudeOutput(let sessionId, let data):
    if sessionId != state.currentSessionId { break }
```

**WebSocketMessage.swift (1 fix)**

12. **status_update decoder** — Tries `content` field first (matching server format), falls back to `status`:
```swift
let status = try (try? container.decode(String.self, forKey: .content))
    ?? container.decode(String.self, forKey: .status)
```

### Build Error Follow-up

The parallel agents introduced 2 Swift compilation errors that were fixed in a quick follow-up:

- `if let sessionId` used on non-optional `String` — changed to `if sessionId !=`
- `try` placement on `??` expression — moved `try` to wrap the entire nil-coalescing expression

### Test Updates

- Updated 8 existing `claudeOutput` tests to set `state.confirmSessionSwitch(sessionId: "s1")` (required by new filtering)
- Added new test: `claude_output ignores messages from different session`
- **Final result: 299 tests passing**

## Prevention Strategies

### Core Anti-Patterns to Watch For

1. **Resource Leaks** — Every `fsp.open()`, state flag toggle, or resource acquisition must use try/finally. No exceptions.
2. **Validation Gaps** — All user-supplied IDs must pass allowlist regex + length bounds before any use in file paths or shell commands.
3. **Data Isolation** — Every message handler that receives a `sessionId` must filter by current session at the entry point, before any processing.

### Code Review Checklist

- [ ] Every `fsp.open()` has a matching `fh.close()` in a `finally` block
- [ ] State flags (`pauseBroadcast`) set/reset in try/finally
- [ ] All message handlers filter by sessionId before processing
- [ ] User-supplied strings validated before use in `exec()` or file paths
- [ ] No duplicate variable declarations in same function scope
- [ ] Shutdown handler cleans up all resource collections (watchers, intervals, timeouts)
- [ ] No redundant polling when file watchers are active
- [ ] Cache checked before expensive discovery/lookup calls
- [ ] Field names in server broadcasts match client decoder CodingKeys exactly

## Related Documentation

- [Multi-select AppleScript Injection Clipboard Race](../integration-issues/multiselect-applescript-clipboard-race.md) — Related AppleScript injection patterns
- [Claude Code Remote Monitoring Architecture](../integration-issues/claude-code-remote-monitoring.md) — WebSocket streaming and session discovery architecture
- [Triaging Multi-Agent Review Findings](../integration-issues/triaging-multi-agent-review-findings.md) — Multi-agent review patterns
- [Swift Structured Concurrency Pitfalls](./swift-structured-concurrency-pitfalls-observable-classes.md) — @Observable class patterns
- [Phase 8 Review Fixes](../code-quality/phase-8-review-fixes-race-security-perf.md) — Previous review cycle findings
- [Terminal Injection Best Practices](../../docs/guides/TERMINAL_INJECTION_BEST_PRACTICES.md) — AppleScript escaping guide
