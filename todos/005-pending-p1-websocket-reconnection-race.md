---
status: pending
priority: p1
issue_id: "005"
tags: [code-review, frontend, race-condition]
dependencies: []
---

# WebSocket Reconnection Race Condition

## Problem Statement

The reconnection timer is never cancelled. If the connection closes multiple times rapidly (flaky WiFi, server restart), multiple reconnection attempts race against each other, potentially creating multiple simultaneous WebSocket connections. The UI flickers between "Connected!" states, and `ws` variable points to whichever connection assigned itself last.

**Why it matters:** Duplicate connections cause message duplication, state corruption, and confusing UX.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html:820-823`

```javascript
ws.onclose = (event) => {
  // ...
  setTimeout(() => {
    if (authToken) connect();
  }, 3000);
};
```

**Evidence:**
- setTimeout never stored or cancelled
- disconnect() doesn't clear pending reconnects
- No check if ws already exists before connecting
- Rapid onclose events spawn multiple timers

**Discovered by:** julik-frontend-races-reviewer agent

## Proposed Solutions

### Option A: Track and Cancel Reconnect Timer (Recommended)
**Pros:** Simple, direct fix
**Cons:** None
**Effort:** Small
**Risk:** Low

```javascript
let reconnectTimeout = null;

ws.onclose = (event) => {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  // ...
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    if (authToken && !ws) connect();
  }, 3000);
};

function disconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (ws) ws.close();
  ws = null;
  // ...
}
```

### Option B: Add Exponential Backoff
**Pros:** Better for sustained connectivity issues
**Cons:** More complex, delays reconnection
**Effort:** Medium
**Risk:** Low

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected files:** `public/index.html`
**Components:** WebSocket connection management
**Database changes:** None

## Acceptance Criteria

- [ ] Only one reconnection attempt active at a time
- [ ] disconnect() cancels any pending reconnection
- [ ] No duplicate "Connected!" toasts on rapid reconnects

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Always track and cancel timeouts |

## Resources

- PR: N/A
