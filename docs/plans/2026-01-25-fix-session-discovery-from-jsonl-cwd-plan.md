---
title: Fix Session Discovery by Reading CWD from JSONL Files
type: fix
date: 2026-01-25
---

# Fix Session Discovery by Reading CWD from JSONL Files

## Overview

The current session discovery mechanism fails because it tries to reverse-engineer the original file path from Claude's encoded directory names. The encoding is **lossy** (both `/` and `_` become `-`), making accurate reversal impossible.

## Problem Statement

### Current Bug

Directory encoding loses information:
- Path: `/Users/austin/Git_Repos/claude_remote`
- Encoded dir: `-Users-austin-Git-Repos-claude-remote`
- Our reversal: `/Users/austin/Git/Repos/claude/remote` (WRONG!)

This causes sessions to fail with "Session not found or no log file" because we can't match the process CWD to the session files.

### Root Cause

The fallback code in `discoverSessions()` attempts to derive `originalPath` from the directory name:
```javascript
const originalPath = '/' + projectHash.replace(/^-/, '').replace(/-/g, '/');
```

This fails because underscores are also encoded as dashes.

## Proposed Solution

**Read the `cwd` field directly from the JSONL session files.**

Each session file contains the original working directory in its entries:
```json
{"cwd":"/Users/austin/Git_Repos/claude_remote","sessionId":"237eac2f-...","type":"user",...}
```

### Implementation

Replace the fallback directory name parsing with JSONL file scanning:

```javascript
// For projects without sessions-index.json
const files = fs.readdirSync(projectDir);
const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

for (const jsonlFile of jsonlFiles) {
  const fullPath = path.join(projectDir, jsonlFile);
  const sessionId = path.basename(jsonlFile, '.jsonl');

  // Read first few lines to find cwd
  const fd = fs.openSync(fullPath, 'r');
  const buffer = Buffer.alloc(2000);
  fs.readSync(fd, buffer, 0, 2000, 0);
  fs.closeSync(fd);

  const content = buffer.toString('utf8');
  const cwdMatch = content.match(/"cwd":"([^"]+)"/);

  if (cwdMatch) {
    const cwd = cwdMatch[1];
    if (!cwdToProject[cwd]) {
      cwdToProject[cwd] = { projectHash, indexData: { originalPath: cwd, entries: [] } };
    }
    cwdToProject[cwd].indexData.entries.push({
      sessionId,
      fullPath,
      fileMtime: fs.statSync(fullPath).mtime.getTime(),
      modified: fs.statSync(fullPath).mtime.toISOString()
    });
  }
}
```

## Technical Considerations

### Performance
- Reading 2KB from each JSONL file is fast (typically < 1ms per file)
- Only runs on startup and refresh, not on every request
- Could cache results if performance becomes an issue

### Edge Cases
- Sessions with no `cwd` field (very old sessions) - skip them
- Sessions from different machines (e.g., `/home/user/...`) - won't match local processes, that's fine
- Multiple sessions with same CWD - all get added to entries array

### Alternative Approaches Considered

1. **Use sessions-index.json only** - Not all projects have it yet
2. **Parse directory name with heuristics** - Unreliable, the encoding is lossy
3. **Cache the cwd mapping** - Adds complexity, JSONL read is fast enough

## Acceptance Criteria

- [ ] All 6 active Claude processes appear in the session list
- [ ] Clicking any session successfully loads its history
- [ ] Sessions without sessions-index.json work correctly
- [ ] No "Session not found" errors for valid sessions

## Files to Modify

| File | Change |
|------|--------|
| `server.js:139-180` | Replace directory name parsing with JSONL cwd extraction |

## References

### Research Sources
- [claude-conversation-extractor](https://github.com/ZeroSumQuant/claude-conversation-extractor) - Scans ~/.claude/projects for JSONL files
- [claude-JSONL-browser](https://github.com/withLinda/claude-JSONL-browser) - Web-based JSONL viewer
- [Simon Willison's claude-code-transcripts](https://github.com/simonw/claude-code-transcripts) - Session publishing tools

### Key Insight
Other tools don't try to reverse the directory encoding - they either:
1. Let users manually browse/select sessions
2. Use the `sessions-index.json` when available
3. Read metadata directly from JSONL files

Our solution follows approach #3, which is the most reliable for automatic discovery.
