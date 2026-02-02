---
title: "fix: Subagent completion detection delayed by 30s idle timeout"
type: fix
date: 2026-02-01
---

# fix: Instant Subagent Completion Detection

## Problem

When a subagent finishes, the iOS app doesn't show "completed" status for up to **30 seconds**. The last spawned subagent often still shows "starting" long after it's done. This makes the app feel broken — the user sees stale status badges while Claude has already moved on.

## Root Cause

The server has **no active completion signal**. The only mechanism is `SUBAGENT_IDLE_TIMEOUT = 30000` — a 30-second timer that resets on every JSONL write. When the subagent stops writing, the server waits the full 30s before calling `stopSubagent()` which broadcasts `subagent_stop` to iOS.

There IS a definitive completion signal available but it's being **explicitly discarded**:

```javascript
// server.js line 424 — main session watcher
if (entry.type === 'user' && entry.toolUseResult?.agentId) {
    continue; // ← SKIPPED! This is the completion signal.
}

// server.js line 1057 — parseLogEntry
if (entry.toolUseResult?.agentId) {
    return null; // ← SKIPPED here too.
}
```

When a subagent completes, the **parent session's** JSONL gets a `user` entry with `toolUseResult.agentId` set to the subagent's agent ID. This is the Task tool's result — it fires the moment the subagent returns. The `agentId` field directly identifies which subagent completed. No mapping table needed.

## Fix: One Line of Logic, Two Lines of Code

### `server.js` — Main Session Watcher (~line 424)

**Before:**
```javascript
if (entry.type === 'user' && entry.toolUseResult?.agentId) {
    continue; // Skip Task results entirely
}
```

**After:**
```javascript
if (entry.type === 'user' && entry.toolUseResult?.agentId) {
    stopSubagent(sessionId, entry.toolUseResult.agentId);
    continue; // Still skip broadcasting the content (streamed via subagent_output)
}
```

That's the entire fix. When the parent session logs the Task tool_result, we call `stopSubagent()` immediately. This:

1. Closes the subagent file watcher
2. Clears the idle timeout
3. Broadcasts `subagent_stop` to iOS
4. iOS sets `state.activeSubagents[agentId].status = "completed"`

The existing `continue` stays — we still don't broadcast the Task tool_result content because it was already streamed via the `subagent_output` channel.

### `server.js` — `stopSubagent()` Log Message (~line 889)

Update the log to distinguish completion from idle timeout:

**Before:**
```javascript
console.log(`[Subagent ${agentId}] Stopped (idle timeout)`);
```

**After:**
```javascript
console.log(`[Subagent ${agentId}] Stopped (${reason || 'idle timeout'})`);
```

Add a `reason` parameter to `stopSubagent`:

```javascript
function stopSubagent(sessionId, agentId, reason) {
```

Call site in main watcher: `stopSubagent(sessionId, agentId, 'task completed')`.
Call site in idle timeout: unchanged (defaults to `'idle timeout'`).

### `server.js` — `parseLogEntry()` (~line 1057)

Also needs the same treatment for consistency (though the main watcher `continue` on line 424 means this path rarely fires):

**Before:**
```javascript
if (entry.toolUseResult?.agentId) {
    return null;
}
```

No change needed here — `parseLogEntry` is a pure parser and shouldn't have side effects. The `stopSubagent` call belongs in the watcher loop where we have `sessionId` in scope.

## Files to Modify

| File | Change | Lines |
|------|--------|-------|
| `server.js` | Add `stopSubagent()` call before `continue` in main watcher | ~424 |
| `server.js` | Add `reason` parameter to `stopSubagent()` function signature + log | ~871, ~889 |

**No iOS changes needed.** The `subagent_stop` message is already decoded and handled correctly by `AppCoordinator.swift:423`.

## Idle Timeout Stays as Fallback

The 30s idle timeout (`resetSubagentIdleTimeout`) is kept unchanged as a safety net for edge cases:

- Subagent crashes without writing a tool_result to the parent JSONL
- JSONL file watcher misses the write event
- Race condition where subagent file appears before the parent log entry

The timeout just becomes the fallback instead of the primary mechanism.

## Edge Cases

| Case | Handling |
|------|----------|
| `stopSubagent` called twice (completion + idle timeout) | Already safe — checks `sessionData.subagentWatchers.has(agentId)`, no-ops if already stopped |
| Multiple subagents complete simultaneously | Each gets its own `toolUseResult.agentId` — handled independently |
| Subagent completes before its watcher is set up | `stopSubagent` no-ops (watcher not in map). Idle timeout won't fire either. Harmless — iOS already shows "starting" which self-clears on session status change |
| History replay on reconnect | History parser (line 1603) still skips these entries — correct, since `subagent_stop` is sent during live watching only |
| Parent session watcher processes batch with Task result | `stopSubagent` fires inline during the batch loop. The subagent's own watcher may still have pending data to flush — `stopSubagent` closes the watcher, which is fine since all critical output was already streamed |

## Acceptance Criteria

- [ ] `swift build` passes
- [ ] `swift test` passes (372+ tests)
- [ ] Subagent shows "completed" within ~2s of finishing (vs 30s before)
- [ ] Multiple parallel subagents each show "completed" promptly when done
- [ ] Idle timeout still fires for zombie subagents (test by killing a subagent process)
- [ ] Server logs show `Stopped (task completed)` for normal completions
- [ ] No duplicate `subagent_stop` broadcasts (stopSubagent is idempotent)

## Testing

### Manual
1. Spawn 2-3 subagents via Task tool
2. Watch iOS — each should flip to "completed" within seconds of finishing
3. Verify server log shows `Stopped (task completed)` (not `idle timeout`)

### Verification Command
```bash
# Watch server logs for completion signals
grep -E "Subagent.*Stopped" /tmp/claude-remote-server.log
```

## References

- `stopSubagent()`: `server.js:871`
- Main watcher skip: `server.js:424`
- `parseLogEntry` skip: `server.js:1057`
- iOS handler: `AppCoordinator.swift:423`
- Idle timeout: `server.js:590`, `server.js:864`
