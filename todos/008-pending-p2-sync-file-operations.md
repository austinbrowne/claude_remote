---
status: pending
priority: p2
issue_id: "008"
tags: [code-review, performance, nodejs]
dependencies: []
---

# Synchronous File Operations Block Event Loop

## Problem Statement

The server uses synchronous filesystem operations (`readdirSync`, `statSync`, `readFileSync`, `readSync`) throughout, blocking the Node.js event loop. During large file reads or slow filesystem access, all WebSocket clients experience latency.

**Why it matters:** Event loop blocking causes all clients to lag during file operations.

## Findings

**Locations:** `/Users/austin/Git_Repos/claude_remote/server.js`
- Lines 37-41: `discoverSessions()` - readdirSync, existsSync
- Lines 48-56: Session discovery loop - readFileSync, statSync
- Lines 100-102: `watchSession()` - statSync
- Lines 116-122: File watcher callback - statSync, openSync, readSync, closeSync
- Lines 406-412: `sendRecentHistory()` - existsSync, readFileSync

**Evidence:**
- 8+ synchronous file operations
- Event loop blocked during each operation
- Multiple clients affected simultaneously

**Discovered by:** performance-oracle, pattern-recognition-specialist agents

## Proposed Solutions

### Option A: Convert to Async Operations (Recommended)
**Pros:** Non-blocking, proper Node.js pattern
**Cons:** Requires async/await refactor
**Effort:** Medium
**Risk:** Low

```javascript
watcher.on('change', async (filePath) => {
  try {
    const stats = await fs.promises.stat(filePath);
    if (stats.size > lastPosition) {
      const fd = await fs.promises.open(filePath, 'r');
      const buffer = Buffer.alloc(stats.size - lastPosition);
      await fd.read(buffer, 0, buffer.length, lastPosition);
      await fd.close();
      // ...
    }
  } catch (e) {
    console.error('Error reading log file:', e);
  }
});
```

### Option B: Use Worker Threads for Heavy Operations
**Pros:** Complete isolation
**Cons:** Complex, overkill for this use case
**Effort:** Large
**Risk:** Medium

## Acceptance Criteria

- [ ] All filesystem operations use async variants
- [ ] Event loop never blocked by file operations
- [ ] No user-perceivable latency during file reads

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Sync operations are Node.js anti-pattern |
