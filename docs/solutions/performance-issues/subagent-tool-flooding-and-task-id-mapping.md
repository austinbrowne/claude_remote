---
title: "Subagent Tool Message Flooding + Task List ID Mapping"
category: performance-issues
subcategory: message-throttling
tags:
  - subagent
  - throttling
  - performance
  - swiftui
  - observable
  - task-list
  - id-mapping
  - websocket
  - server
components:
  - server.js:watchSubagent
  - server.js:stopSubagent
  - server.js:parseLogEntry
  - WebSocketMessage.swift:taskUpdate
  - AppCoordinator.swift:taskUpdate
  - AppState.swift:clearMessages
symptoms:
  - app-hangs-during-subagent-activity
  - ui-unresponsive-with-explore-agents
  - permission-prompts-queue-invisibly
  - task-updates-silently-fail-to-decode
  - tasks-disappear-after-creation
  - task-progress-never-updates
  - tasks-persist-across-session-switches
root_causes:
  - unthrottled-subagent-tool-messages
  - swiftui-observable-mutation-storm
  - field-name-mismatch-id-vs-taskid
  - pending-to-real-id-never-mapped
  - clearMessages-skips-tasks
severity: high
date_solved: 2026-02-01
---

# Subagent Tool Message Flooding + Task List ID Mapping

## Problem 1: App Hang During Subagent Activity

When Claude Code spawns Explore/Plan agents that rapidly call Grep/Read tools, the server broadcasts every `subagent_tool` message unthrottled. A fast agent doing 20-30 tool calls per second sends 20-30 WebSocket messages per second. Each message triggers 3 `@Observable` mutations on iOS (`activeSubagents[].currentTool`, `activeSubagents[].lastActivity`, `messages[].subagentCurrentTool`), causing a SwiftUI re-render storm that freezes the UI. While hung, permission prompts queue invisibly and dump on reconnect.

## Problem 2: Task List Never Works

The task list UI (TaskProgressView) existed but was completely non-functional due to multiple compounding bugs:

1. **Field name mismatch**: Server sent `task_update` with `id` field, iOS decoder expected `taskId` — all updates silently failed to decode
2. **Pending-to-real ID gap**: Server generated `pending-${Date.now()}` IDs for `task_create`, but Claude Code assigns integer IDs (1, 2, 3...) used by `task_update`. No mapping existed, so updates couldn't find their tasks.
3. **Missing fields**: Server omitted `activeForm` and `description` from `task_update`, so in-progress spinner text was lost
4. **Tasks not cleared**: `clearMessages()` didn't clear `tasks`, so stale tasks persisted across session switches

## Root Cause

### Flooding
The subagent watcher in `server.js` (`watchSubagent()`) broadcast every tool_use and permission_request from subagent log files as `subagent_tool` messages with no rate limiting. These are cosmetic status updates (showing which tool the subagent is currently using) that don't need real-time fidelity.

### Task ID Lifecycle
Claude Code's task lifecycle: `TaskCreate` tool_use (no real ID yet) -> tool_result with "Created task 3: ..." (real ID assigned) -> `TaskUpdate` tool_use with `taskId: "3"`. The server only saw the tool_use for TaskCreate (generating a pending ID) but never correlated the tool_result back to learn the real ID.

## Solution

### Throttling (server.js)

Per-agent throttle map limits `subagent_tool` to max 1 per 500ms per agent:

```javascript
const subagentToolThrottles = new Map(); // agentId -> lastSentTimestamp
const SUBAGENT_TOOL_THROTTLE_MS = 500;

// In subagent tool broadcast:
const now = Date.now();
const lastSent = subagentToolThrottles.get(agentId) || 0;
if (now - lastSent >= SUBAGENT_TOOL_THROTTLE_MS) {
    subagentToolThrottles.set(agentId, now);
    broadcastToClients({ type: 'subagent_tool', ... });
}

// Clean up on subagent stop:
subagentToolThrottles.delete(agentId);
```

This reduces tool messages from ~20-30/sec to max 2/sec per agent — sufficient for the cosmetic card update.

### Task ID Mapping (server.js)

Two maps track the ID lifecycle:

```javascript
const pendingTaskIds = new Map();  // tool_use_id -> pendingId
const taskIdMap = new Map();       // realId -> pendingId
```

- **TaskCreate tool_use**: store `block.id -> pendingId`
- **tool_result for TaskCreate**: parse "Created task 3: ..." from result text, store `"3" -> pendingId`
- **TaskUpdate tool_use**: look up `taskIdMap.get(realId)` to rewrite to the pending ID iOS knows

### Field Name Fix (server.js)

Changed `id` to `taskId` in `task_update` messages, added `description` and `activeForm` fields.

### iOS Changes

- `WebSocketMessage.swift`: extended `taskUpdate` enum case from 3 to 5 parameters (`activeForm`, `description`)
- `AppCoordinator.swift`: apply new fields in handler, falling back to existing values if nil
- `AppState.swift`: added `tasks.removeAll()` to `clearMessages()`

## Prevention

- **Throttle cosmetic WebSocket messages by default.** Any message that only updates a visual indicator (spinner text, current tool name) should be throttled server-side. The iOS render cost per message is non-trivial due to `@Observable` diffing.
- **Match field names between server and client using shared type definitions or integration tests.** The `id` vs `taskId` mismatch went undetected because the decoder fell through to the `unknown` case silently.
- **Test the full ID lifecycle for any server-generated temporary IDs.** When the server creates placeholder IDs, it must track the mapping to real IDs assigned by the upstream system.
- **Clear all session-scoped state in `clearMessages()`.** Any new array/dictionary added to AppState that is session-scoped should be cleared here.

## Files Modified

| File | Change |
|------|--------|
| `server.js` | Throttle map + filter for subagent_tool; fix task_update field name; add ID mapping; forward activeForm/description |
| `WebSocketMessage.swift` | Add activeForm/description to taskUpdate enum + decoder |
| `AppCoordinator.swift` | Destructure and apply new taskUpdate fields |
| `AppState.swift` | Clear tasks in clearMessages() |

## Cross-References

- Related: [Permission Queue for Concurrent Subagents](../concurrency-issues/permission-queue-concurrent-subagents.md) — permission prompts queuing invisibly was a symptom of this hang
- Related: [Chokidar Watcher Reliability](../integration-issues/chokidar-watcher-reliability.md) — same file watcher infrastructure
