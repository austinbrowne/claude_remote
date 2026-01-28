---
status: pending
priority: p3
issue_id: "037"
tags:
  - performance
  - code-review
  - cleanup
dependencies: []
---

# Redundant Polling Configuration

## Problem Statement

The file watcher uses both 500ms polling (`usePolling: true, interval: 500`) AND a 2-second fallback polling interval. This is redundant and wastes resources.

**Why it matters**: Unnecessary CPU cycles polling the same file twice.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js`

```javascript
const watcher = chokidar.watch(session.logFile, {
  persistent: true,
  usePolling: true,   // 500ms polling
  interval: 500,
  // ...
});

// Fallback polling interval - check file every 2 seconds
const pollInterval = setInterval(() => {
  watcher.emit('change', session.logFile);
}, 2000);
```

**Discovered by:** performance-oracle agent

## Proposed Solutions

### Option A: Remove fallback polling (Recommended)
- Keep 500ms chokidar polling
- Remove the 2-second `setInterval` fallback
- **Pros:** Simpler, less resource usage
- **Cons:** May miss updates if chokidar fails
- **Effort:** Small
- **Risk:** Low

### Option B: Keep fallback, increase interval
- Change fallback to 5-10 seconds
- Only for edge case recovery
- **Pros:** Belt-and-suspenders reliability
- **Cons:** Still some redundancy
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] Only one polling mechanism active
- [ ] File changes still detected reliably
- [ ] Reduced CPU usage

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-27 | Created | Found during code review |
