---
module: Real-time communication
date: 2026-03-10
problem_type: logic_error
component: realtime
symptoms:
  - "WebSocket delta replay could re-inject session_delta events, causing infinite recursion"
  - "Meta/recovery events (session_status, typing, heartbeat) polluting recentEvents buffer"
  - "Lost prompt popups due to no server-side pending prompt state tracking"
  - "Double data from server due to missing sequence-based deduplication"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [websocket, event-replay, delta, recursion, deduplication, sequence-number, prompt-state, liveness]
language: javascript
framework: express
---

# Troubleshooting: Recursive event replay in WebSocket delta handlers causes infinite loop

## Problem

When implementing cursor-based delta replay for WebSocket reconnection, session_delta events stored in the server's recentEvents buffer would be re-sent to reconnecting clients. The client's handleSessionDelta handler would then process those replayed delta events, which themselves contained events — creating an infinite replay loop.

## Environment

- Module: Real-time communication (WebSocket event architecture)
- Language/Framework: JavaScript / Express + ws
- Affected Component: Server broadcastToClients, client handleSessionDelta, session liveness
- Date: 2026-03-10

## Symptoms

- WebSocket delta replay could re-inject session_delta events, causing infinite recursion
- Meta/recovery events (session_status, typing, heartbeat) polluting recentEvents buffer and being replayed unnecessarily
- Lost prompt popups due to no server-side pending prompt state tracking
- Double/duplicate data from server due to missing sequence-based deduplication
- Lost sessions when Claude process briefly unresponsive (no liveness grace period)

## What Didn't Work

**Attempted Solution 1:** Client-only filtering of session_delta from replayed events
- **Why it failed:** Necessary but insufficient — the server was still storing meta events in the buffer, wasting space and causing unnecessary replays. Defense-in-depth requires filtering on BOTH sides.

**Attempted Solution 2:** Simple blocklist of session_delta type only
- **Why it failed:** Other meta/recovery types (session_status, typing, heartbeat, pending_prompts, session_suspect, session_alive) also don't belong in the replay buffer. A comprehensive exclusion set is needed.

## Solution

Implemented a defense-in-depth exclusion strategy with matching sets on server and client:

**Server-side (server.js) — EXCLUDED_FROM_REPLAY set:**
```javascript
// Before (broken):
// All events stored in recentEvents, including meta types
sessionData.recentEvents.push({ seq, ...message, timestamp: Date.now() });

// After (fixed):
const EXCLUDED_FROM_REPLAY = new Set([
  'session_status', 'typing', 'heartbeat',
  'session_delta', 'pending_prompts', 'session_suspect', 'session_alive'
]);

function broadcastToClients(sessionId, message) {
  if (!EXCLUDED_FROM_REPLAY.has(message.type)) {
    const seq = ++sessionData.lastBroadcastSeq;
    sessionData.recentEvents.push({ seq, ...message, timestamp: Date.now() });
  }
  // ... broadcast to clients
}
```

**Client-side (connection.js) — handleSessionDelta filter:**
```javascript
// Before (broken):
// All events in delta replayed through handleMessage
for (const event of msg.events) {
  handleMessage(event);
}

// After (fixed):
for (const event of msg.events) {
  if (event.type === 'session_delta' || event.type === 'pending_prompts') continue;
  handleMessage(event);
}
```

**Additional fixes in this architecture:**
- `safeSend(ws, payload)` helper wrapping ws.send in try/catch for CLOSING/CLOSED sockets
- `sendPendingPrompts(ws, sessionId, sessionData)` single source of truth for prompt serialization
- Sequence numbers (pre-increment `++lastBroadcastSeq`) on all non-excluded events for client-side dedup
- Liveness state machine with 3-strike grace period before declaring session dead

## Why This Works

1. **ROOT CAUSE:** Meta/recovery event types were being stored in the server's recentEvents buffer alongside content events. When a client reconnected and requested a delta replay, these meta events — especially `session_delta` — would be re-sent, causing the client's handler to recursively process them.

2. **Defense-in-depth:** The server excludes meta types from storage (they never enter the buffer), AND the client filters them during replay (guard against any that slip through). Both sides enforce the invariant independently.

3. **Pre-increment seq prevents off-by-one:** Server uses `++sessionData.lastBroadcastSeq` (pre-increment), so seq starts at 1, not 0. Client initializes `lastReceivedSeq = 0`. The check `msg.seq <= lastReceivedSeq` correctly accepts seq=1 as the first message. This was flagged as a CRITICAL bug in review but disproved by the Adversarial Validator.

## Prevention

- **Always exclude meta/recovery events from replay buffers.** When building cursor-based replay systems, identify which event types are transient (status, typing indicators, heartbeats) vs durable (output, tool results, prompts) and only store durable events.
- **Defense-in-depth for event filtering.** Apply exclusion on BOTH the storage side (server doesn't buffer) AND the consumption side (client filters during replay). Neither side should trust the other to get it right.
- **Use pre-increment for sequence numbers** (`++seq` not `seq++`) to avoid seq=0 ambiguity when clients initialize their dedup counter at 0.
- **Test exclusion sets for drift.** When the same exclusion set exists in multiple files (server + client + tests), add assertions that detect drift between them.
- **Wrap ws.send in try/catch.** WebSocket connections can transition to CLOSING/CLOSED between readyState check and send call. A `safeSend` helper prevents uncaught exceptions.
- **Run adversarial validation on code reviews.** Multiple findings in this review (seq=0, fromSeq Infinity, null guards) were false positives caught by the Adversarial Validator reading actual code paths rather than speculating.

## Related Issues

- No prior solutions in docs/solutions/ for this pattern
