---
status: complete
priority: p3
issue_id: "018"
tags: [code-review, quality, refactoring]
dependencies: []
---

# Duplicate "Other Watching" Check Logic

## Problem Statement

The pattern for checking if any other client is watching a session is copy-pasted in two places.

**Why it matters:** Code duplication, error-prone maintenance.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js:321-329, 362-368`

## Proposed Solutions

### Option A: Extract Helper Function (Recommended)
**Effort:** Small

```javascript
function isAnyoneWatching(sessionId, excludeWs = null) {
  for (const [ws, data] of clients) {
    if (ws !== excludeWs && data.watchingSessions.has(sessionId)) return true;
  }
  return false;
}

function maybeUnwatchSession(sessionId, excludeWs) {
  if (!isAnyoneWatching(sessionId, excludeWs)) {
    unwatchSession(sessionId);
  }
}
```

## Acceptance Criteria

- [x] Single helper function for this check
- [x] Used in both disconnect and unwatch handlers

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Identified during pattern analysis |
