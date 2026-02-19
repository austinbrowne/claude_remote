---
title: "Subagent deferred permissions trapped when no new content arrives"
category: logic-errors
tags: [server, subagent, permissions, polling, chokidar]
severity: high
date: 2026-02-18
---

# Subagent Deferred Permissions Trapped

## Problem

When Claude Code spawns subagents (e.g., team mode with 5 parallel Read calls), all `permission_request` entries arrive in a single batch. The server's subagent watcher defers these to a `pendingPermissions` Map for one poll cycle to catch auto-approvals. But if no new content is written to the log file (because the subagent is waiting for user permission), the chokidar watcher never fires again, and the deferred permissions are trapped forever.

**Symptom:** iOS/web client shows no permission prompt. The subagent silently stalls. User has no way to approve the batch.

## Root Cause

The main session watcher has a 2-second fallback poll (`setInterval`) that flushes pending state even when no file changes occur. The subagent watcher did NOT have this fallback. The deferral logic works correctly when content arrives incrementally, but fails when all permissions arrive at once and the agent goes idle.

```
Batch 1: [perm_1, perm_2, perm_3, perm_4, perm_5] → all deferred to pendingPermissions
Batch 2: (never happens — no new content written)
→ pendingPermissions never flushed → client never sees prompts
```

## Fix

Added a 2-second `setInterval` fallback poll to subagent watchers, matching the main watcher pattern:

```javascript
const SUBAGENT_FALLBACK_POLL_MS = 2000;
const subagentFallbackPoll = setInterval(
  () => processFileContent(logFile),
  SUBAGENT_FALLBACK_POLL_MS
);
sessionData.subagentPollIntervals.set(agentId, subagentFallbackPoll);
```

Cleanup in `stopSubagent()` and `unwatchSession()` clears the interval.

## Gotchas

1. **Post-clearInterval ghost tick:** A `setInterval` callback already queued in the JS event loop fires once after `clearInterval`. Guard with `if (!sessionData.subagentWatchers.has(agentId)) return;` at the top of `processFileContent`.

2. **Re-entrancy guard already exists:** The `processing` boolean prevents concurrent `processFileContent` calls from the watcher and the poll timer.

3. **The deferral logic itself is correct** — the bug was only the missing poll timer to trigger the second-cycle flush.

## Files

- `server.js` — `watchSubagent()`, `stopSubagent()`, `unwatchSession()`
- `test/subagent-deferred-permissions.test.js` — 9 tests covering the deferral algorithm
