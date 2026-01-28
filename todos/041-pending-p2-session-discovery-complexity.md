---
status: pending
priority: p2
issue_id: "041"
tags:
  - performance
  - code-review
  - optimization
dependencies: []
---

# O(N*M) Session Discovery Complexity

## Problem Statement

Session discovery has O(N*M) complexity: for each iTerm session (N), it scans all log directories (M). With many sessions or large ~/.claude/projects directory, this becomes slow.

**Why it matters**: Discovery time grows quadratically with scale.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js:40-100`

**Current algorithm:**
1. Get all iTerm sessions with `claude` in command (N)
2. For each session, search all project directories for matching session ID (M)
3. Result: O(N * M) comparisons

**Example with 10 iTerm sessions and 50 project directories:**
- Current: 500 directory scans
- Optimal: 10 + 50 = 60 operations

**Discovered by:** performance-oracle agent

## Proposed Solutions

### Option A: Build index first, then match (Recommended)
```javascript
// 1. Build index of all sessions (O(M))
const sessionIndex = new Map();
for (const projectDir of projectDirs) {
  for (const sessionFile of sessionFiles) {
    sessionIndex.set(sessionId, filePath);
  }
}

// 2. Match iTerm sessions against index (O(N))
for (const itermSession of itermSessions) {
  const logFile = sessionIndex.get(itermSession.id);
  if (logFile) sessions.push({...});
}
```
- **Pros:** O(N + M) instead of O(N * M)
- **Cons:** Slightly more memory for index
- **Effort:** Medium
- **Risk:** Low

### Option B: Cache discovery results
- Only re-discover every 30 seconds
- Use cached results between refreshes
- **Pros:** Faster repeated calls
- **Cons:** Stale data risk
- **Effort:** Small
- **Risk:** Medium

## Acceptance Criteria

- [ ] Session discovery under 500ms with 50+ sessions
- [ ] No duplicate directory scans
- [ ] All sessions still discovered correctly

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-27 | Created | Found during performance review |
