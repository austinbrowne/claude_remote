---
title: Post-review fixes for race conditions, security hardening, performance, and dead code
date: 2026-01-31
category: code-quality
tags: [swift, swiftui, ios, nodejs, websocket, race-condition, security, performance, dead-code, code-review, multi-agent]
module: ClaudeRemote iOS + server.js
severity: high
symptoms:
  - Session switch streams old session data into new session view
  - History and live messages interleave out of order
  - LCS diff freezes UI on large edits
  - Auto-mode mic stays hot after speech cancellation
  - AUTH_TOKEN prefix leaked in startup banner
  - Unlimited WebSocket auth attempts
  - HistoryEntry and ClaudeOutputData are near-identical structs
  - WebSocket URL construction duplicated in 3 files
  - Dead ClientAction cases never called
  - Duplicate status handling in AppCoordinator
root_cause: Accumulated technical debt from 7 rapid development phases; 6-agent parallel review surfaced 14 findings across race conditions, security, performance, and code quality
resolution: Fixed 10 findings in one pass; session unwatch on switch, broadcast pause during history, async diff, speech cancellation via existing helper, token redaction, auth brute-force limit, model deduplication, URL helper extraction, dead code removal, pattern match consolidation
---

# Post-Review Fixes: Race Conditions, Security, Performance, Dead Code

## Problem Statement

After completing the tool_use/tool_result card merge feature (Phase 8), a 6-agent parallel review (security-sentinel, performance-oracle, architecture-strategist, code-simplicity-reviewer, pattern-recognition-specialist, julik-frontend-races-reviewer) surfaced 14 prioritized findings. 10 were selected for immediate fix; 4 lower-priority items (AppleScript injection, prototype pollution, syntax highlighting cache, `nonisolated(unsafe)` audit) were deferred as local-network-only mitigations or future optimization.

## Findings and Fixes

### 1. Session Switch Race: Old Watcher Not Stopped (Critical)

**Symptom:** Switching sessions on iOS cleared the message list but the server continued streaming from the old session's file watcher. Old messages could bleed into the new session view.

**Root Cause:** `AppCoordinator.watchSession()` sent `watch_session` to the server but never sent `unwatch_session` for the previous session.

**Fix:** Added unwatch before watch in `AppCoordinator.swift`:

```swift
if let previous = state.currentSessionId, previous != sessionId {
    webSocket?.send(.unwatchSession(sessionId: previous))
}
```

The server's `maybeUnwatchSession()` already handles cleanup when no clients are watching.

### 2. History/Live Message Interleaving (Critical)

**Symptom:** When watching a new session, live log entries from the file watcher could arrive mid-history-send, causing messages to appear out of order.

**Root Cause:** In `server.js`, `watchSession()` starts the chokidar file watcher immediately, then `sendRecentHistory()` reads and sends history. The watcher can fire events during the async history read.

**Fix:** Added `pauseBroadcast` flag on client data in `server.js`:

```javascript
// In watch_session handler:
clientData.pauseBroadcast = true;
await sendRecentHistory(ws, msg.sessionId);
await sendActiveSubagents(ws, msg.sessionId);
clientData.pauseBroadcast = false;

// In broadcastToClients:
if (ws.readyState === WebSocket.OPEN && !clientData.pauseBroadcast) {
```

Events during the pause window are dropped (not queued). This is acceptable because history already covers recent content, and the watcher will pick up any new writes after resume.

### 3. LCS Diff Blocking Main Thread (High)

**Symptom:** `DiffView.computeDiff()` runs O(m*n) LCS synchronously in SwiftUI's `onAppear`. Large diffs freeze the UI.

**Root Cause:** View struct methods inherit `@MainActor` isolation from the `View` protocol. The heavy computation ran synchronously on the main thread.

**Fix:** Moved to `Task.detached` and marked pure functions `nonisolated`:

```swift
.task {
    if computedLines == nil {
        let old = oldString
        let new = newString
        let lines = await Task.detached(priority: .userInitiated) {
            DiffView.computeDiff(old: old, new: new)
        }.value
        computedLines = lines
    }
}
```

Key: `computeDiff`, `simpleDiff`, `longestCommonSubsequence`, and `maxLCSComplexity` all need `nonisolated` to be callable from a detached task. The existing loading spinner UI (`ProgressView`) now actually displays during computation.

### 4. Auto-Mode Speech Cancellation Gap (High)

**Symptom:** When auto-mode fires for a new prompt, it called `stopSpeaking()` but not `stopListening()`, leaving the microphone hot from the previous prompt cycle.

**Root Cause:** The code manually called `speechService.stopSpeaking()` instead of the existing `cancelAutoModeSpeech()` helper, which handles both speaking AND listening cleanup.

**Fix:** One-line change in `AppCoordinator.swift`:

```swift
// Before:
autoModeSpeechTask?.cancel()
speechService.stopSpeaking()

// After:
cancelAutoModeSpeech()
```

**Lesson:** When a cleanup helper exists, always use it. Partial cleanup is a common source of state leaks.

### 5. Token Prefix in Startup Log (High)

**Symptom:** Server startup banner printed `AUTH_TOKEN.substring(0, 10)`, leaking the first 10 characters.

**Fix:** Replaced with bullet characters: `Token: ••••••••••••••••`.

### 6. HistoryEntry / ClaudeOutputData Deduplication (Medium)

**Symptom:** Two structs with 10 identical fields (`type`, `content`, `tool`, `input`, `language`, `status`, `questions`, `isDestructive`, `toolUseId`, `isError`). `HistoryEntry` existed solely because `ClaudeOutputData` had an extra `usage` field -- but `usage` was never read.

**Fix:** Removed `HistoryEntry` entirely. History now decodes directly into `[ClaudeOutputData]`. Also removed `TokenUsageData` struct and `usage` field (dead code). Removed `messageFromHistoryEntry()` from AppCoordinator -- history entries now use the same `messageFromClaudeOutput()` path as live messages.

### 7. Dead ClientAction Cases (Medium)

**Symptom:** `ClientAction.catchUp` and `ClientAction.getState` were defined with `toJSON()` encoding but never called anywhere in the codebase.

**Fix:** Removed both cases and their corresponding test cases (276 tests remain, down from 278).

### 8. WebSocket URL Construction Consolidated (Medium)

**Symptom:** Three places manually built WebSocket URLs with scheme conversion and path appending: `WebSocketService.buildWebSocketURL()`, `AppCoordinator.reconnect()`, and `AuthView.connect()`.

**Fix:** Added `WebSocketService.webSocketURL(from:)` static helper. Both `AppCoordinator` and `AuthView` now call it instead of inline URL construction. The helper handles all scheme variants (`http`, `https`, `ws`, `wss`) and ensures `/ws` path.

### 9. Brute-Force Protection on WebSocket Auth (Medium)

**Symptom:** Unlimited auth attempts allowed per connection. A client could brute-force tokens.

**Fix:** Added per-connection `authFailures` counter. After 3 failed attempts, connection is closed with `4001 Too many failed auth attempts`.

### 10. Duplicate Status Handling (Medium)

**Symptom:** `.sessionStatus(_, let status, _)` and `.statusUpdate(let status)` had identical 5-line handler bodies in AppCoordinator.

**Fix:** Combined into a single pattern match: `case .sessionStatus(_, let status, _), .statusUpdate(let status):`.

## What Was Deferred

| Finding | Reason |
|---------|--------|
| AppleScript command injection | Local-network only; `exec` → `execFile` change would require restructuring all AppleScript calls |
| Prototype pollution in settings | Local-network only; allowlist would add maintenance burden for little real-world risk |
| Syntax highlighting cache | Optimization, not a bug; no user-reported jank |
| `nonisolated(unsafe)` audit in SpeechService | Existing code works correctly; full audit is a separate scope |

## Prevention Strategies

1. **Use existing cleanup helpers** -- When `cancelAutoModeSpeech()` exists, don't partially replicate its logic. Grep for cleanup functions before writing inline cleanup.
2. **Pause broadcasts during async state transitions** -- Whenever history/state is loaded asynchronously while a watcher is active, gate the broadcast to avoid interleaving.
3. **Mark pure computation functions `nonisolated`** -- View struct methods inherit `@MainActor`. Any heavy computation should be `nonisolated static` so it can run off the main thread.
4. **Audit for model duplication after each phase** -- New phases tend to introduce slightly-different copies of existing models. Catch these early.
5. **Remove dead code immediately** -- Dead enum cases and unused structs accumulate fast. Remove them when spotted, don't defer.

## Verification

- `swift build` passes with no new warnings
- `swift test` passes: 276 tests in 24 suites (2 tests removed for dead code)
- All 10 fixes verified by reviewing the changed code paths

## References

- Review session: 6-agent parallel review (security, performance, architecture, simplicity, patterns, race conditions)
- `server.js`: lines 1073-1086 (broadcastToClients), 1224-1239 (watch_session handler), 1177-1189 (auth handler), 1900 (startup banner)
- `AppCoordinator.swift`: lines 70-77 (watchSession), 222-233 (auto-mode), 236-252 (status handling)
- `DiffView.swift`: lines 66-71 (task), 74-172 (computation)
- `WebSocketMessage.swift`: HistoryEntry removal, TokenUsageData removal, ClientAction cleanup
- `WebSocketService.swift`: `webSocketURL(from:)` static helper
