---
status: pending
priority: p2
issue_id: "010"
tags: [code-review, performance, file-watching]
dependencies: []
---

# File Polling at 100ms Intervals Causes CPU Overhead

## Problem Statement

The file watcher uses polling at 100ms intervals instead of native filesystem events. Each watched session triggers stat calls every 100ms, causing unnecessary CPU usage and preventing system power optimization.

**Why it matters:** With 10 sessions, that's 100 stat calls per second. Wastes battery on laptops.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js:107-112`

```javascript
const watcher = chokidar.watch(session.logFile, {
  persistent: true,
  usePolling: true,
  interval: 100
});
```

**Evidence:**
- `usePolling: true` disables native events
- 100ms interval = 10 polls/second/session
- macOS has efficient FSEvents that should be used

**Discovered by:** performance-oracle agent

## Proposed Solutions

### Option A: Use Native File Events (Recommended)
**Pros:** Zero CPU overhead when files unchanged
**Cons:** Slightly different timing characteristics
**Effort:** Small
**Risk:** Low

```javascript
const watcher = chokidar.watch(session.logFile, {
  persistent: true,
  usePolling: false,  // Use native FSEvents on macOS
  awaitWriteFinish: {
    stabilityThreshold: 100,
    pollInterval: 100
  }
});
```

## Acceptance Criteria

- [ ] Native file events used (FSEvents on macOS)
- [ ] CPU overhead near zero when no file changes
- [ ] Still detects changes promptly

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Polling should be last resort |
