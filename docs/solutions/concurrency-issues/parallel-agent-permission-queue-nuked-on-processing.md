---
title: "Parallel Agent Permissions Silently Dropped on session_status Processing"
category: concurrency-issues
subcategory: state-lifecycle
tags:
  - permissions
  - parallel-agents
  - queue
  - multi-agent
  - session-status
  - web-client
  - ios
  - prompt-service
components:
  - PromptService.swift:handleSessionStatus
  - PromptService.swift:cascadeAlwaysAllow
  - connection.js:tool_result handler
  - prompts.js:respondToPermission
symptoms:
  - permissions-silently-dropped
  - parallel-agents-hang-waiting
  - allow-always-doesnt-prevent-future-prompts
  - web-client-permissions-all-dismissed-on-any-result
root_causes:
  - clearQueue-on-processing-status
  - cascade-not-persisting-to-allowedTools
  - web-tool-result-nukes-all-permissions
severity: high
date_solved: 2026-02-08
---

# Parallel Agent Permissions Silently Dropped on session_status Processing

## Problem

When Claude Code spawns 3+ parallel subagents (swarm, fresh-eyes-review), each agent independently requests tool permissions. The FIFO queue architecture from Phase 7 worked for sequential requests, but `handleSessionStatus(.processing)` called `clearQueue()`, nuking ALL pending prompts when ANY agent started processing. Permissions from still-waiting agents were silently dropped, causing sessions to hang.

Secondary issues: "Allow Always" didn't persist client-side so future same-tool requests still prompted, and the web client had the same bug but worse — its `tool_result` handler removed ALL queued permissions on ANY result.

### Symptoms

- 3+ parallel agents spawned, only 1-2 permission prompts shown
- Sessions hang after "Allow Always" — agent still waiting for permission that was nuked
- Web client: tapping "Yes" on one permission dismisses all other queued permissions
- No error messages — prompts silently disappear

### Root Causes

**1. `handleSessionStatus(.processing)` calls `clearQueue()`.** Designed for single-agent mode where "processing" means the agent moved on. In multi-agent mode, one agent processing doesn't mean others are done waiting. Each prompt has its own lifecycle via `tool_result` events.

**2. `cascadeAlwaysAllow` didn't persist to `allowedTools`.** After tapping "Always", the cascade removed queued same-tool permissions, but didn't update the `allowedTools` set. New permissions arriving after the cascade still showed prompts until the server pushed updated permissions.

**3. Web client `tool_result` handler nuked ALL permissions.** `connection.js` had a reverse-iteration loop removing ALL permission entries from `promptQueue` on ANY `tool_result`, plus unconditionally hiding the current permission card. No `toolUseId`-scoped dismissal.

## Solution

### A. Remove clearQueue from processing handler (iOS)

```swift
// Before: nuked everything on processing
public func handleSessionStatus(_ status: SessionStatus) {
    if status == .processing { clearQueue() }
}

// After: no-op — each prompt dismissed by its own tool_result
public func handleSessionStatus(_ status: SessionStatus) {
    // Intentionally empty. Prompts self-clean via tool_result events.
    // Session disconnect/switch still calls clearQueue() explicitly.
}
```

### B. Persist "Always" grants client-side

```swift
private func cascadeAlwaysAllow(tool: String) {
    allowedTools.insert(tool)  // NEW: auto-skip future requests
    // ... existing cascade removal of pending + queued ...
}
```

### C. Web client: toolUseId-scoped dismissal

```javascript
// Before: nuke all permissions
for (let i = promptQueue.length - 1; i >= 0; i--) {
  if (promptQueue[i].type === 'permission') promptQueue.splice(i, 1);
}

// After: dismiss only matching toolUseId
if (resultToolUseId) {
  for (let i = promptQueue.length - 1; i >= 0; i--) {
    if (promptQueue[i].toolUseId === resultToolUseId) {
      promptQueue.splice(i, 1);
      break;
    }
  }
}
```

Required propagating `toolUseId` through all permission creation paths: `connection.js` main-session, `ui.js` subagent, and `sessions.js` recovery.

### D. Web client: cascade on "Always Allow"

```javascript
function respondToPermission(response, tool) {
  if (response === '2' && tool) {
    alwaysAllowedTools.add(tool);
    for (let i = promptQueue.length - 1; i >= 0; i--) {
      if (promptQueue[i].type === 'permission' && promptQueue[i].tool === tool) {
        promptQueue.splice(i, 1);
      }
    }
  }
  respondToPrompt(response);
}
```

## Key Gotchas

1. **Platform parity matters.** The iOS FIFO queue fix didn't cover the web client, which had the same bugs in different code. Always check ALL clients when fixing shared protocol behavior.

2. **"clearQueue on processing" is wrong for multi-agent.** Any global state reset triggered by a single agent's lifecycle event will break multi-agent mode. Use per-item lifecycle (toolUseId matching) instead.

3. **Client-side permission grants fill the gap.** Server-side "always allow" takes a round-trip. Inserting into `allowedTools` client-side prevents the race window where new permissions arrive before the server confirms.

4. **`toolUseId` is the correlation key.** Without it, you can't do per-item dismissal. The web client had `toolUseId` available from the server but wasn't using it for permission lifecycle management.

5. **Static HTML doesn't update reactively.** The web client's `showPromptCard` renders HTML once. New queue items don't update the displayed card's batch button count. Need explicit re-render calls (unlike SwiftUI which is reactive).

## Prevention

- When adding queue/lifecycle management, audit ALL clients (iOS + web) for the same patterns
- Test with 3+ parallel agents requesting the same tool permission simultaneously
- Use `toolUseId` for all permission lifecycle operations (show, dismiss, cascade)
- Avoid global state resets (`clearQueue`, "nuke all permissions") in response to per-item events

## Related

- `docs/solutions/concurrency-issues/permission-queue-concurrent-subagents.md` — Original FIFO queue architecture (Phase 7)
