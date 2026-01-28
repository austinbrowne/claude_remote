---
status: complete
priority: p3
issue_id: "022"
tags: [code-review, quality, operations]
dependencies: []
---

# No Graceful Shutdown Handling

## Problem Statement

The server lacks signal handlers for graceful shutdown. When terminated, file watchers and WebSocket connections are not properly cleaned up.

**Why it matters:** Resource leaks on restart, potential file descriptor exhaustion.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js` (missing feature)

## Proposed Solutions

### Option A: Add Signal Handlers (Recommended)
**Effort:** Small

```javascript
function shutdown() {
  console.log('Shutting down...');
  activeSessions.forEach((data, sessionId) => {
    data.watcher.close();
    data.logsDirWatcher?.close();
  });
  clients.forEach((data, ws) => ws.close(1001, 'Server shutdown'));
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

## Acceptance Criteria

- [ ] SIGTERM/SIGINT trigger graceful shutdown
- [ ] All watchers closed
- [ ] All WebSocket clients notified

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Always handle shutdown signals |
