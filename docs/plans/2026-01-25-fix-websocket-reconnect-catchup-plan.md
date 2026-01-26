---
title: Fix WebSocket Reconnect and Catchup Logic
type: fix
date: 2026-01-25
---

# Fix WebSocket Reconnect and Catchup Logic

## Problem Statement

When backgrounding the browser, switching tabs, or locking the phone:
1. WebSocket appears connected but is actually dead ("frozen socket")
2. Messages that occurred while away don't populate
3. Commands fail to send silently
4. No proper reconnection happens

This is a known iOS Safari issue - it aggressively kills WebSocket connections when backgrounded but doesn't always fire `onclose`.

## Root Causes

### 1. No Visibility Change Detection
The app doesn't listen for `visibilitychange` events to detect when user returns.

### 2. Frozen Socket Problem
iOS Safari can leave WebSocket in "OPEN" state (`readyState === 1`) but the socket is non-functional. Calls to `.send()` silently fail.

### 3. No Session Re-subscription
After reconnecting, the code doesn't re-watch the active session or fetch missed history.

### 4. Weak Reconnect Logic
Single reconnect attempt after 3 seconds with no exponential backoff.

## Proposed Solution

### 1. Add Visibility Change Handler

```javascript
// Detect when user returns from background
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkConnectionHealth();
  }
});
```

### 2. Implement Connection Health Check

```javascript
let pingTimeout = null;

function checkConnectionHealth() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (!reconnectTimeout) reconnect();
    return;
  }

  // Send ping, expect pong within 3 seconds
  if (pingTimeout) clearTimeout(pingTimeout);
  pingTimeout = setTimeout(() => forceReconnect(), 3000);

  try {
    ws.send(JSON.stringify({ action: 'ping' }));
  } catch (e) {
    clearTimeout(pingTimeout);
    forceReconnect();
  }
}

// In handleMessage, clear timeout on pong:
// case 'pong': clearTimeout(pingTimeout); break;

function forceReconnect() {
  if (pingTimeout) clearTimeout(pingTimeout);
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  reconnect();
}
```

### 3. Add Ping/Pong to Server

```javascript
// server.js - handle ping action
case 'ping':
  ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
  break;
```

### 4. Re-subscribe on Reconnect

```javascript
function reconnect() {
  const savedSessionId = currentSessionId;
  currentSessionId = null;

  showToast('Reconnecting...', 'error');
  connect();

  // After connection established, re-watch session
  const originalOnOpen = ws.onopen;
  ws.onopen = (event) => {
    originalOnOpen?.(event);
    reconnectAttempts = 0;

    if (savedSessionId) {
      wsSend({ action: 'watch_session', sessionId: savedSessionId });
    }
  };
}
```

### 5. Exponential Backoff for Reconnect

```javascript
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

function scheduleReconnect() {
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;

  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    reconnect();
  }, delay);
}

// Reset attempts on successful connection
ws.onopen = () => {
  reconnectAttempts = 0;
  // ...
};
```

## Implementation

### public/index.html Changes

**Add to state variables (around line 960):**
```javascript
let reconnectAttempts = 0;
let pingTimeout = null;
const MAX_RECONNECT_DELAY = 30000;
```

**Add visibility change listener (in DOMContentLoaded):**
```javascript
document.addEventListener('visibilitychange', handleVisibilityChange);
```

**Add new functions:**
```javascript
function handleVisibilityChange() {
  if (document.visibilityState === 'visible' && authToken) {
    checkConnectionHealth();
  }
}

function checkConnectionHealth() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (!reconnectTimeout) reconnect();
    return;
  }

  // Send ping, expect pong within 3 seconds
  if (pingTimeout) clearTimeout(pingTimeout);
  pingTimeout = setTimeout(() => forceReconnect(), 3000);

  try {
    ws.send(JSON.stringify({ action: 'ping' }));
  } catch (e) {
    clearTimeout(pingTimeout);
    forceReconnect();
  }
}

function forceReconnect() {
  if (pingTimeout) clearTimeout(pingTimeout);
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  document.getElementById('statusDot').classList.remove('connected');
  reconnect();
}

function reconnect() {
  if (reconnectTimeout) return;

  const savedSessionId = currentSessionId;
  currentSessionId = null;

  showToast('Reconnecting...', 'error');
  connect();

  // Re-watch session after connection
  const originalOnOpen = ws.onopen;
  ws.onopen = (event) => {
    originalOnOpen?.(event);
    reconnectAttempts = 0;

    if (savedSessionId) {
      wsSend({ action: 'watch_session', sessionId: savedSessionId });
    }
  };
}
```

**Modify ws.onclose:**
```javascript
ws.onclose = (event) => {
  document.getElementById('statusDot').classList.remove('connected');

  if (event.code === 4001) {
    showToast('Invalid token', 'error');
    disconnect();
    return;
  }

  // Schedule reconnect with exponential backoff
  if (authToken && !reconnectTimeout) {
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    showToast(`Disconnected - reconnecting in ${Math.round(delay/1000)}s...`, 'error');
    reconnectAttempts++;

    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      reconnect();
    }, delay);
  }
};
```

**Handle pong in handleMessage:**
```javascript
case 'pong':
  if (pingTimeout) clearTimeout(pingTimeout);
  break;
```

### server.js Changes

**Add ping handler in handleClientMessage:**
```javascript
case 'ping':
  ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
  break;
```

## Acceptance Criteria

- [ ] Locking phone and unlocking triggers reconnect check
- [ ] Switching tabs and returning triggers reconnect check
- [ ] Backgrounding browser and returning triggers reconnect check
- [ ] Dead socket detected via ping/pong, forces reconnect
- [ ] After reconnect, previously watched session is re-subscribed
- [ ] After reconnect, recent history is fetched (fills gap)
- [ ] Reconnect uses exponential backoff (1s, 2s, 4s, 8s... max 30s)
- [ ] Status dot accurately reflects connection state
- [ ] Commands can be sent after reconnect

## Files to Modify

| File | Changes |
|------|---------|
| `public/index.html:960` | Add state variables for reconnect |
| `public/index.html:1000` | Add visibilitychange listener in DOMContentLoaded |
| `public/index.html:1095-1145` | Modify connect() and add reconnect functions |
| `public/index.html:1167` | Add pong handler in handleMessage |
| `server.js:596` | Add ping handler in handleClientMessage |

## References

- [WebSocket iOS Safari Issues](https://github.com/socketio/socket.io/issues/2924)
- [Frozen Socket Problem](https://bugs.webkit.org/show_bug.cgi?id=228296)
- [Ably: WebSockets and iOS Challenges](https://ably.com/topic/websockets-ios)
- [graphql-ws Safari Reconnect Discussion](https://github.com/enisdenjo/graphql-ws/discussions/290)
