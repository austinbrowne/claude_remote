---
status: pending
priority: p2
issue_id: "016"
tags: [code-review, frontend, race-condition]
dependencies: []
---

# Session Switch Message Race Condition

## Problem Statement

When rapidly switching sessions, messages from the old session that are in-flight may arrive after the UI has cleared and switched to the new session. There's no transition state tracking, resulting in old session messages appearing in the new session's view.

**Why it matters:** Users see confusing message pollution from wrong sessions.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html:864-882, 916-926`

```javascript
function switchSession() {
  const sessionId = document.getElementById('sessionSelector').value;
  if (!sessionId) return;

  document.getElementById('outputArea').innerHTML = '';  // Clear immediately

  ws.send(JSON.stringify({
    action: 'watch_session',
    sessionId: sessionId
  }));
  // No waiting for confirmation before accepting messages
}

case 'claude_output':
  if (msg.sessionId === currentSessionId) {  // currentSessionId may be stale
    appendMessage(msg.data);
  }
```

**Evidence:**
- Output cleared before server confirms switch
- `currentSessionId` updated asynchronously
- In-flight messages from old session can arrive

**Discovered by:** julik-frontend-races-reviewer agent

## Proposed Solutions

### Option A: Implement Session State Machine (Recommended)
**Pros:** Robust state tracking
**Cons:** More complex state management
**Effort:** Medium
**Risk:** Low

```javascript
const SESSION_STATE = { IDLE: 0, SWITCHING: 1, ACTIVE: 2 };
let sessionState = SESSION_STATE.IDLE;
let pendingSessionId = null;

function switchSession() {
  sessionState = SESSION_STATE.SWITCHING;
  pendingSessionId = sessionId;
  // ...send watch_session
}

// In handleMessage 'watching':
if (msg.sessionId === pendingSessionId) {
  currentSessionId = msg.sessionId;
  sessionState = SESSION_STATE.ACTIVE;
}

// In handleMessage 'claude_output':
if (sessionState === SESSION_STATE.ACTIVE && msg.sessionId === currentSessionId) {
  appendMessage(msg.data);
}
```

## Acceptance Criteria

- [ ] Messages from old session never appear after switch
- [ ] State machine tracks transition phases
- [ ] UI indicates switching state

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Async state changes need explicit tracking |
