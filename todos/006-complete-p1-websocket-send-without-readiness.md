---
status: complete
priority: p1
issue_id: "006"
tags: [code-review, frontend, reliability]
dependencies: []
---

# WebSocket Send Without Readiness Check

## Problem Statement

Multiple places in the client code call `ws.send()` without checking if the WebSocket is in OPEN state. If the connection is CONNECTING, CLOSING, or CLOSED, these calls throw exceptions or fail silently, causing user actions to be lost.

**Why it matters:** User clicks "Send" while reconnecting - their command vanishes without feedback.

## Findings

**Locations:** `/Users/austin/Git_Repos/claude_remote/public/index.html`
- Line 922-926: `switchSession()`
- Line 929: `refreshSessions()`
- Line 1001-1004: `sendCommand()`
- Line 1014: `sendPreset()`
- Line 1020: `sendEscape()`

```javascript
// No readiness check before send
ws.send(JSON.stringify({
  action: 'watch_session',
  sessionId: sessionId
}));
```

**Evidence:**
- No `ws.readyState === WebSocket.OPEN` checks
- No try/catch around send calls
- No user feedback on send failure

**Discovered by:** julik-frontend-races-reviewer, pattern-recognition-specialist agents

## Proposed Solutions

### Option A: Create Guarded Send Function (Recommended)
**Pros:** Single point of fix, consistent error handling
**Cons:** None
**Effort:** Small
**Risk:** Low

```javascript
function wsSend(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Not connected', 'error');
    return false;
  }
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (e) {
    showToast('Send failed', 'error');
    return false;
  }
}

// Usage
if (!wsSend({ action: 'inject', command: command })) return;
```

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected files:** `public/index.html`
**Components:** All WebSocket send operations
**Database changes:** None

## Acceptance Criteria

- [ ] All ws.send() calls go through guarded function
- [ ] User sees error toast if send fails
- [ ] No uncaught exceptions on send to closed socket

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Always check WebSocket readyState before send |

## Resources

- MDN: WebSocket.readyState
