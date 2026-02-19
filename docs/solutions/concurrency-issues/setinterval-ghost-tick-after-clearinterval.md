---
title: "setInterval callback fires once after clearInterval due to event loop queuing"
category: concurrency-issues
tags: [javascript, nodejs, event-loop, timer, cleanup]
severity: medium
date: 2026-02-18
---

# setInterval Ghost Tick After clearInterval

## Problem

When `clearInterval(id)` is called, any callback already queued in the Node.js event loop for that interval will still execute once. This means cleanup code that calls `clearInterval` and then deletes associated state can leave a dangling callback that runs against deleted/stale state.

## Root Cause

`setInterval` queues callbacks into the event loop's timer phase. Once a callback is queued, `clearInterval` only prevents FUTURE callbacks — it cannot remove already-queued ones. In single-threaded Node.js, this matters when:

1. Interval callback is queued
2. Synchronous cleanup code runs (clearInterval + delete state)
3. Event loop resumes → queued callback fires against deleted state

## Fix

Guard the callback with a state existence check:

```javascript
const processFileContent = async (filePath) => {
  // Guard against post-stop ghost ticks
  if (!sessionData.subagentWatchers.has(agentId)) return;
  // ... actual processing
};

const poll = setInterval(() => processFileContent(logFile), 2000);

// Cleanup:
function stop() {
  sessionData.subagentWatchers.delete(agentId); // State removed first
  clearInterval(poll);                           // Then interval cleared
  // Ghost tick will check .has(agentId) → false → return
}
```

**Alternative:** Use `setTimeout` chaining instead of `setInterval` — the next timer is only set after the current callback completes, so there's no queued callback to fire after cleanup.

## Gotchas

1. **Order matters in cleanup:** Delete the state marker BEFORE calling `clearInterval`, so the ghost tick sees the marker is gone.
2. **This is NOT a race condition** in the traditional sense — Node.js is single-threaded. It's a sequential event loop ordering issue.
3. **`processing` boolean guards don't help here** — the ghost tick fires when `processing` is false (after the previous real call finished).

## Files

- `server.js` — `processFileContent` guard + `stopSubagent()` cleanup order
