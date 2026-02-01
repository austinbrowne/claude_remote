---
title: "Chokidar File Watcher Reliability for Log Streaming"
category: integration-issues
subcategory: file-watching
tags:
  - chokidar
  - fsevents
  - file-watcher
  - log-streaming
  - jsonl
  - polling
  - awaitWriteFinish
  - node
components:
  - server.js:watchSession
  - server.js:processLogChanges
symptoms:
  - output-silently-stops-updating
  - missed-log-entries
  - partial-lines-in-output
  - concurrent-read-corruption
  - watcher-follows-wrong-session
root_causes:
  - awaitWriteFinish-suppresses-events
  - no-concurrency-guard-on-reads
  - no-fallback-for-missed-events
  - auto-switch-to-unrelated-log-files
severity: high
date_solved: 2026-02-01
---

# Chokidar File Watcher Reliability for Log Streaming

## Problem

The Node.js server uses chokidar to watch Claude Code JSONL log files and stream updates to the iOS app via WebSocket. Output would silently stop updating — the watcher stopped firing events even though the log file was still being written to. This caused the mobile app to appear frozen with no new messages.

### Symptoms

- Chat output stops mid-conversation, no new messages appear
- Reconnecting or refreshing doesn't help (watcher is stale)
- Server logs show no file change events despite active Claude session
- Occasional partial/corrupted JSON lines in output

### Root Causes

**1. `awaitWriteFinish` suppresses events on continuously-written files.** Chokidar's `awaitWriteFinish` option waits for a file to stop changing before emitting an event. Claude Code JSONL files are written to continuously during active sessions — the file never "finishes" writing, so events are suppressed/coalesced indefinitely.

**2. No concurrency guard.** When a fallback poll and chokidar event fire simultaneously, two concurrent reads can overlap, causing duplicate or corrupted data.

**3. No fallback for missed events.** Both macOS FSEvents and polling can miss rapid writes. Without a fallback mechanism, a single missed event means output stops until the next write triggers a new event.

**4. Auto-switch follows wrong session.** The logs directory watcher automatically switched to any new `.jsonl` file, even if it belonged to a different Claude session in the same project directory.

## Solution

### A. Remove awaitWriteFinish

```javascript
// Before: events suppressed on continuously-written files
const watcher = chokidar.watch(session.logFile, {
    persistent: true,
    usePolling: true,
    interval: 500,
    binaryInterval: 500,
    awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100
    }
});

// After: immediate events, partial lines handled by reader
const watcher = chokidar.watch(session.logFile, {
    persistent: true,
    usePolling: true,
    interval: 500,
    binaryInterval: 500
    // NOTE: No awaitWriteFinish — it suppresses/coalesces change events on
    // continuously-written log files, causing output to silently stop updating.
    // Partial lines are handled by the lastNewlineIndex guard below.
});
```

Partial lines are already handled by the `lastNewlineIndex` guard — only complete lines (ending with `\n`) are processed, and `lastPosition` only advances to the end of the last complete line.

### B. Extract processLogChanges with concurrency guard

```javascript
let processing = false;

async function processLogChanges() {
    if (processing) return;
    processing = true;
    try {
        let continueReading = true;
        while (continueReading) {
            continueReading = false;
            const stats = await fsp.stat(session.logFile);
            if (stats.size > lastPosition) {
                // ... read and process ...
                if (stats.size > lastPosition) {
                    continueReading = true;  // More data, drain it
                }
            }
        }
    } finally {
        processing = false;
    }
}
```

The `processing` boolean prevents concurrent reads. The `while` loop drains all available data in one pass rather than relying on re-emitted events.

### C. Add fallback poll

```javascript
const FALLBACK_POLL_MS = 2000;
const fallbackPoll = setInterval(() => processLogChanges(), FALLBACK_POLL_MS);
```

A 2-second interval catches any events missed by chokidar. The concurrency guard ensures it doesn't overlap with event-driven reads. The interval is stored and cleaned up on session unwatch.

### D. Remove auto-switch to new log files

```javascript
// Before: automatically switched watcher to any new .jsonl file
logsDirWatcher.on('add', (newFile) => {
    if (newFile.endsWith('.jsonl')) {
        watcher.unwatch(session.logFile);
        session.logFile = newFile;
        lastPosition = 0;
        watcher.add(newFile);
    }
});

// After: log-only, no auto-switch
logsDirWatcher.on('add', (newFile) => {
    if (newFile.endsWith('.jsonl')) {
        console.log(`[Session] New log file in project dir: ${path.basename(newFile)}`);
    }
});
```

Multiple Claude sessions can share a project directory. Auto-switching caused the watcher to follow an unrelated session's log file.

## Key Gotchas

1. **`awaitWriteFinish` is designed for batch file uploads, not streaming logs.** It waits for the file to stop being modified. For continuously-written files, this means events are indefinitely delayed or coalesced into nothing.

2. **macOS FSEvents is unreliable for rapid writes.** Even with `usePolling: true`, chokidar can miss events. A fallback poll is essential for reliability.

3. **The drain loop is critical.** Without it, when `MAX_READ_SIZE` bytes are read but more data remains, the code relied on `setImmediate(() => watcher.emit('change', filePath))` to re-trigger. This was fragile — the extracted function with a `while` loop is deterministic.

4. **Concurrency guard must use `finally`.** If `processing = false` isn't in a `finally` block, any thrown error permanently locks the reader.

5. **Don't remove verbose logging too aggressively.** Per-line broadcast logs were removed for cleanliness, but keep error-level and state-change logs for debugging production issues.

## Prevention

- For streaming file watchers, never use `awaitWriteFinish`. Handle partial data in the reader instead.
- Always pair event-driven file watching with a fallback poll. The cost (one stat call every 2s) is negligible compared to the cost of silently dropped events.
- Use a concurrency guard (`processing` flag) when multiple triggers can invoke the same async reader.
- Don't auto-switch resources based on filesystem events in shared directories. Require explicit user action for session switching.

## Related

- `docs/solutions/integration-issues/claude-code-remote-monitoring.md` — Original watcher implementation and session discovery
- `docs/solutions/code-quality/phase-8-review-fixes-race-security-perf.md` — Broadcast pausing during async transitions
