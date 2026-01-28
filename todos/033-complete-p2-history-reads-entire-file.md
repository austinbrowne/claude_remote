---
status: complete
priority: p2
issue_id: "033"
tags:
  - performance
  - code-review
  - memory
dependencies: []
---

# History Loading Reads Entire JSONL File

## Problem Statement

The `sendRecentHistory()` function reads the entire JSONL file into memory before extracting the last 100 lines. For long sessions, these files can grow to hundreds of MB.

**Why it matters**: Memory exhaustion on the server, potential crashes, and slow response times when loading session history.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js` lines 631-660

```javascript
function sendRecentHistory(ws, sessionId) {
  // ...
  const content = fs.readFileSync(sessionData.session.logFile, 'utf8');  // Entire file!
  const lines = content.split('\n').filter(line => line.trim());
  const recentLines = lines.slice(-100);
  // ...
```

**Problems:**
1. Reads entire file into memory (could be 100+ MB)
2. Creates large string, then splits into array
3. No error handling for locked/missing files
4. Potential incomplete final line

## Proposed Solutions

### Option A: Read only last N bytes (Recommended)
```javascript
const HISTORY_READ_SIZE = 100 * 1024; // 100KB should contain 100 lines

function sendRecentHistory(ws, sessionId) {
  const stats = fs.statSync(logFile);
  const readSize = Math.min(stats.size, HISTORY_READ_SIZE);
  const fd = fs.openSync(logFile, 'r');
  const buffer = Buffer.alloc(readSize);
  fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
  fs.closeSync(fd);

  const content = buffer.toString('utf8');
  // Skip first partial line
  const firstNewline = content.indexOf('\n');
  const safeContent = firstNewline > 0 ? content.slice(firstNewline + 1) : content;
  // ...
}
```
- **Pros**: Bounded memory usage, fast
- **Cons**: May read incomplete line at start (handled)
- **Effort**: Low
- **Risk**: Low

### Option B: Stream-based reading with line counting
- Use readline or line-reader to process from end
- **Pros**: Most memory efficient
- **Cons**: More complex, slower
- **Effort**: Medium
- **Risk**: Low

## Recommended Action

Option A - Read only last 100KB and find complete lines.

## Technical Details

**Affected files:**
- `server.js:631-660` - sendRecentHistory()

## Acceptance Criteria

- [ ] History loading reads bounded amount of data
- [ ] Memory usage stays constant regardless of file size
- [ ] Partial lines handled correctly
- [ ] Error handling for missing/locked files
- [ ] Tested with large JSONL files (10MB+)

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-26 | Created | Identified during performance and data integrity reviews |

## Resources

- Performance oracle agent finding
- Data integrity guardian agent finding
