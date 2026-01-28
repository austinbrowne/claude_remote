---
status: complete
priority: p2
issue_id: "051"
tags:
  - performance
  - code-review
dependencies: []
---

# discoverSessions() Called on Every Inject/Escape

## Problem Statement

Every inject or escape command triggers a full session discovery, which involves shell execs, file reads, and git operations. This is massive overkill for a simple "send escape key" operation.

**Why it matters**:
- With 5 sessions: ~25 file operations + 7 shell execs per inject
- At rate limit (10 commands/min): 250+ file ops/minute just for inject
- Adds 100-300ms latency from AppleScript execution

## Findings

**Location:** `server.js:1134, 1166`

**Current (expensive):**
```javascript
case 'inject':
  discoverSessions().then(currentSessions => {
    const targetSession = currentSessions.find(s => s.id === msg.sessionId);
```

**What discoverSessions() does per call:**
- Runs `ps` command
- Runs `lsof` command
- Reads all project directories
- Opens 2KB from every `.jsonl` file
- Runs `git rev-parse` for each process
- Performs multiple `fsp.access()` calls

## Proposed Solutions

### Option A: Use Cached activeSessions First (Recommended)
```javascript
case 'inject':
  const cachedSession = activeSessions.get(msg.sessionId)?.session;
  let targetTty = cachedSession?.tty;

  if (!targetTty && msg.sessionId) {
    const sessions = await getCachedSessions();
    const found = sessions.find(s => s.id === msg.sessionId);
    targetTty = found?.tty;
  }
```
- **Pros:** Eliminates discovery for watched sessions entirely
- **Cons:** Cached TTY could be stale
- **Effort:** Small
- **Risk:** Low (fallback to discovery)

### Option B: Lightweight TTY Refresh
Create minimal function that only looks up current TTY:
```javascript
async function refreshSessionTty(sessionId) {
  const sessionData = activeSessions.get(sessionId);
  if (!sessionData?.session?.cwd) return null;

  const procs = await getActiveClaude();
  const match = procs.find(p => p.cwd === sessionData.session.cwd);
  return match?.tty;
}
```
- **Pros:** Just ps + lsof, no file scanning
- **Cons:** Still some overhead
- **Effort:** Medium
- **Risk:** Low

### Option C: Session Cache with TTL
```javascript
const sessionCache = { data: null, timestamp: 0, TTL: 2000 };

async function getCachedSessions() {
  if (sessionCache.data && (Date.now() - sessionCache.timestamp) < sessionCache.TTL) {
    return sessionCache.data;
  }
  sessionCache.data = await discoverSessions();
  sessionCache.timestamp = Date.now();
  return sessionCache.data;
}
```
- **Pros:** Reuses discovery across rapid commands
- **Cons:** 2-second staleness window
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] Inject/escape don't trigger full discovery when session is watched
- [ ] Response time for inject < 200ms
- [ ] Fallback to discovery when cached data unavailable

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-27 | Created | Performance review finding |
