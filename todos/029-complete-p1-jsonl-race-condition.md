---
status: pending
priority: p1
issue_id: "029"
tags:
  - data-integrity
  - code-review
  - race-condition
dependencies: []
---

# Race Condition in JSONL File Reading

## Problem Statement

The file watcher in `server.js` has a race condition when reading JSONL files. Partial JSON lines may be read if a write is in progress, and rapid file changes can cause overlapping reads with incorrect positions.

**Why it matters**: This can cause missed log entries, corrupted data, or crashes from malformed JSON - directly impacting the reliability of session monitoring.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js` lines 249-284

```javascript
watcher.on('change', (filePath) => {
  // ...
  const bytesToRead = Math.min(stats.size - lastPosition, MAX_READ_SIZE);
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(bytesToRead);
  fs.readSync(fd, buffer, 0, bytesToRead, lastPosition);
  fs.closeSync(fd);

  const newContent = buffer.toString('utf8');
  const lines = newContent.split('\n').filter(line => line.trim());
  // ...
  lastPosition += bytesToRead;  // Updated AFTER processing
```

**Problems:**
1. **Partial JSON lines**: Read may capture incomplete JSON line mid-write
2. **lastPosition not atomic**: Rapid watcher fires can read overlapping data
3. **No truncation handling**: If file is rotated (size < lastPosition), negative read attempted

## Proposed Solutions

### Option A: Atomic position management (Recommended)
- Read from end of last complete line, not byte position
- Track line boundaries, not byte counts
- Handle file truncation explicitly
- **Pros**: Robust against race conditions
- **Cons**: Slightly more complex
- **Effort**: Medium
- **Risk**: Low

### Option B: Debounce file changes
- Wait 100ms after last change before reading
- Coalesce rapid changes into single read
- **Pros**: Simple, reduces race window
- **Cons**: Adds latency, doesn't eliminate race
- **Effort**: Low
- **Risk**: Medium

### Option C: Use fs.watch with atomic reads
- Read entire recent section, find complete lines
- Skip partial final line
- **Pros**: Simple logic
- **Cons**: May re-read same data
- **Effort**: Low
- **Risk**: Low

## Recommended Action

Option A - Atomic position management with line-boundary tracking.

## Technical Details

**Affected files:**
- `server.js:249-284` - watcher change handler
- `server.js:326-332` - activeSessions Map (stores stale lastPosition)

**Fix approach:**
```javascript
watcher.on('change', (filePath) => {
  try {
    const stats = fs.statSync(filePath);

    // Handle file truncation/rotation
    if (stats.size < lastPosition) {
      console.log(`[Watcher] File truncated, resetting position`);
      lastPosition = 0;
    }

    // Read new content
    const content = fs.readFileSync(filePath, 'utf8').slice(lastPosition);

    // Only process complete lines
    const lastNewline = content.lastIndexOf('\n');
    if (lastNewline === -1) return; // No complete lines yet

    const completeContent = content.slice(0, lastNewline);
    lastPosition += completeContent.length + 1;

    // Process complete lines only
    const lines = completeContent.split('\n').filter(l => l.trim());
    // ...
  } catch (e) {
    console.error('Error reading log file:', e);
  }
});
```

## Acceptance Criteria

- [ ] Partial JSON lines never processed
- [ ] File truncation detected and handled
- [ ] Rapid file changes don't cause data loss
- [ ] Position tracking is consistent
- [ ] Tested with high-frequency log writes

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-26 | Created | Identified during data integrity review |

## Resources

- Data integrity guardian agent finding
- Node.js fs documentation on atomic operations
