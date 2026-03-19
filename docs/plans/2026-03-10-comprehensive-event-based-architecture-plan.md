---
type: standard
title: "Lightweight Event-Based Architecture for Server-to-Client Communication"
date: 2026-03-10
status: approved
security_sensitive: true
priority: high
breaking_change: false
revised: true
revision_date: 2026-03-10
revision_reason: "Simplified from comprehensive EventStore design to lightweight inline approach per multi-agent review consensus (Architecture REVISION_REQUESTED, Simplicity BLOCK, Adversarial BLOCK)"
---

# Plan: Lightweight Event-Based Architecture for Server-to-Client Communication

## Document Info
- **Author:** AI + CyngeX
- **Date:** 2026-03-10
- **Status:** approved
- **Reviewers:** CyngeX
- **Revision:** Rewritten from comprehensive plan after 5-agent review consensus that full EventStore + protocol versioning + state machine was over-engineered for a single-user, 1-3 client app

## Problem

The current server-to-client communication uses a file-polling + broadcast pattern with no message identity. This causes three persistent reliability issues:

1. **Lost prompt popups** — Permission requests and AskUserQuestion prompts silently disappear. Root causes: deferred permission timing gaps, `session_status → processing` auto-dismissing prompts, fragile history-based prompt recovery on reconnect, no authoritative server-side prompt state.

2. **Double data / double inputs** — Users see duplicated output and sometimes send duplicate approvals. Root causes: `broadcastToClients` sends to all connected tabs with no dedup key, fallback poll + chokidar overlap can process same data twice, `catch_up` replays full history over already-rendered content, deferred permission + 5s verification timeout can broadcast same permission twice.

3. **Lost sessions** — Sessions disappear from the webview while still running on the machine. Root causes: 15s liveness check kills sessions when processes briefly disappear, `getActiveClaude()` returning empty causes `unwatchSession` cleanup, no distinction between "temporarily unreachable" and "actually dead."

4. **Inject-race vulnerability** — User responds to a prompt from a replaced session, and the command is injected into the wrong TTY. No session ID validation on inject/select_option/escape handlers. Confirmed TOCTOU race condition.

**Business impact:** These issues force users to switch to the terminal directly, defeating the purpose of the remote monitoring app. The prompt loss issue is the most critical — missed permission prompts stall Claude indefinitely.

## Goals
- **G1:** Eliminate lost prompts — server maintains authoritative pending prompt state; clients always receive pending prompts on connect/reconnect
- **G2:** Eliminate duplicate messages — sequence numbers on all events enable client-side dedup
- **G3:** Eliminate false session loss — grace period before declaring sessions dead
- **G4:** Fix inject-race — validate session is active before TTY injection

## Non-Goals
- Separate EventStore or PromptStateTracker classes (inline on activeSessions)
- Protocol versioning / v1/v2 negotiation (coordinated deploy of server + iOS)
- Formal state machine class (failCount threshold is sufficient)
- New files (all changes are to existing files)
- Multi-server/clustered deployment
- Replacing the JSONL log file as source of truth
- Changing the chokidar/polling file-watching mechanism

## Solution

Add **4 fields to each `activeSessions` entry** and make **targeted modifications** to existing functions. No new files, no new classes. Estimated ~150 lines of additions/modifications total (including edge case handling).

### Key Changes

1. **`pendingPrompts` Map on activeSessions** — Server-side authoritative prompt state. Tracks `permission_request` and `ask_user_question` lifecycle. Sent to clients on `watch_session` for immediate prompt recovery.

2. **`lastBroadcastSeq` counter on activeSessions** — Monotonic sequence number injected at the `broadcastToClients` function level (1 change point, covers all 34 callsites). Clients track `lastReceivedSeq` and drop duplicates.

3. **`recentEvents` capped array on activeSessions** — Last ~100 events stored as a plain array. Ephemeral message types (e.g., `session_status`, typing indicators) excluded from storage. Enables cursor-based delta replay for brief disconnects (phone backgrounded 30s-2min). Falls back to existing history endpoint for longer gaps. Cap uses periodic compaction (`if (arr.length > 120) arr = arr.slice(-100)`) rather than per-append splice — both are O(n) but compaction amortizes the cost.

4. **`failCount` on activeSessions** — Liveness check increments on failure, resets on success. At `failCount >= 3` (~45s), session declared dead. Broadcasts `session_suspect` at `failCount === 1` for client UI. **Note:** Must verify interaction with existing dead session detection from commit `ea2281c` — reuse or extend the existing counter if one exists, rather than adding a parallel mechanism.

5. **Session ID validation on inject (mitigation)** — Before TTY injection, validate that `activeSessions.get(sessionId)` returns an active (non-dead/replaced) session. Reject stale commands with a generic error message to the client. **Important:** This is a mitigation, not a complete fix for the TOCTOU race — a narrow window remains between validation and injection where the session could be replaced. For a single-user local app where the "wrong target" is another Claude session (not an arbitrary process), this residual risk is accepted.

6. **Replacement session liveness pre-check** — Before broadcasting `session_replaced`, run one synchronous liveness check on the replacement candidate. If it fails, broadcast `session_ended` instead of `session_replaced`. Prevents cascading replacement failures.

7. **Post-answer prompt reconciliation** — After each prompt response, re-send `pending_prompts` to the client so any remaining prompts are immediately visible. Prevents FIFO clearing from silently dropping prompts in multi-prompt scenarios.

8. **Prompt TTL** — Pending prompts older than 10 minutes (with no connected clients watching the session) are expired and removed. On reconnect after TTL, prompts are shown as expired rather than actionable. Prevents stale prompt accumulation.

9. **Cache-busting for coordinated deploy** — Add version query string to served JS files (`<script src="js/connection.js?v=HASH">`) so browser cache doesn't serve stale client code after server update.

## Technical Approach

### Architecture

```
JSONL log file
    ↓ (chokidar + fallback poll — unchanged)
log-parser.js parseLogEntry()
    ↓ (unchanged)
updatePromptState(sessionData, event)  ← NEW: inline function, updates pendingPrompts Map
    ↓
sessionData.recentEvents.push(event)   ← NEW: stores in capped array
    ↓
broadcastToClients(event)              ← MODIFIED: injects seq from sessionData.lastBroadcastSeq++
    ↓
client receives event with seq         ← client drops if seq <= lastReceivedSeq
```

### Data Flow

**New fields on activeSessions entries:**
```javascript
// In watchSession() or wherever activeSessions entries are created:
activeSessions.set(sessionId, {
  // ... existing 16 fields unchanged ...

  // NEW: Authoritative prompt state (G1)
  pendingPrompts: new Map(),    // toolUseId → { type, tool, data, seq, timestamp }

  // NEW: Sequence counter for dedup (G2)
  lastBroadcastSeq: 0,         // monotonic, incremented in broadcastToClients

  // NEW: Recent events for reconnection delta (G1 + G2)
  recentEvents: [],            // capped at 100 events, plain array, ephemeral types excluded

  // NEW: Liveness grace period (G3)
  failCount: 0,                // reset on success, dead at >= 3 (verify vs existing ea2281c counter)
});
```

**Modified broadcastToClients (1 change covers all 34 callsites):**
```javascript
// Ephemeral message types excluded from recentEvents replay buffer
const EPHEMERAL_TYPES = new Set(['session_status', 'typing', 'heartbeat']);
const RECENT_EVENTS_CAP = 100;

function broadcastToClients(message) {
  // Look up session to get seq counter
  const sessionData = message.sessionId ? activeSessions.get(message.sessionId) : null;
  let seq = null;

  if (sessionData) {
    seq = ++sessionData.lastBroadcastSeq;

    // Store in recent events buffer (skip ephemeral types that don't make sense on replay)
    if (!EPHEMERAL_TYPES.has(message.type)) {
      const stored = { seq, ...message, timestamp: Date.now() };
      sessionData.recentEvents.push(stored);
      // Periodic compaction — amortized O(n), not per-append splice
      if (sessionData.recentEvents.length > RECENT_EVENTS_CAP + 20) {
        sessionData.recentEvents = sessionData.recentEvents.slice(-RECENT_EVENTS_CAP);
      }
    }
  }

  const enriched = seq != null ? { ...message, seq } : message;
  const data = JSON.stringify(enriched);
  clients.forEach((clientData, ws) => {
    if (ws.readyState === WebSocket.OPEN && !clientData.pauseBroadcast) {
      if (!message.sessionId || clientData.watchingSessions.has(message.sessionId)) {
        ws.send(data);
      }
    }
  });
}
```

**Prompt state tracking (inline function, not a class):**
```javascript
function updatePromptState(sessionData, event) {
  if (!sessionData || !event) return;

  if (event.type === 'permission_request' || event.type === 'ask_user_question') {
    // toolUseId is reliable for permission_request (from log-parser.js block.id)
    // ask_user_question has no correlation ID — use seq-based fallback
    const promptId = event.toolUseId || `prompt-${sessionData.lastBroadcastSeq}`;
    sessionData.pendingPrompts.set(promptId, {
      promptId,
      type: event.type,
      tool: event.tool,
      toolUseId: event.toolUseId,
      data: event,
      seq: sessionData.lastBroadcastSeq,
      timestamp: Date.now()
    });
  }

  if (event.type === 'tool_result' && event.toolUseId) {
    sessionData.pendingPrompts.delete(event.toolUseId);
  }

  if (event.type === 'user') {
    // Clear oldest ask_user_question (FIFO — acceptable since AskUserQuestion
    // prompts are rare and sequential in practice. toolUseId-based correlation
    // is not available in the JSONL format for these events.)
    for (const [id, prompt] of sessionData.pendingPrompts) {
      if (prompt.type === 'ask_user_question') {
        sessionData.pendingPrompts.delete(id);
        break;
      }
    }
  }
}
```

**Liveness check modification (3 lines added):**
```javascript
// In existing liveness check interval:
if (!processFound) {
  sessionData.failCount = (sessionData.failCount || 0) + 1;

  if (sessionData.failCount === 1) {
    // First failure — warn clients but don't kill session
    broadcastToClients({ type: 'session_suspect', sessionId });
  }

  if (sessionData.failCount >= 3) {
    // 3 consecutive failures (~45s) — declare dead, search for replacement
    // ... existing dead session handling ...
  }

  return; // Don't kill on first failure (current behavior kills immediately)
} else {
  if (sessionData.failCount > 0) {
    broadcastToClients({ type: 'session_alive', sessionId });
  }
  sessionData.failCount = 0;
}
```

**Session ID validation on inject (G4 — inject-race mitigation):**

> **Note:** This is a pre-check mitigation, not a complete TOCTOU elimination. A narrow race window remains between validation and injection. Accepted risk for a single-user local app where the "wrong target" is always another Claude session.

```javascript
// In inject/select_option/escape handlers, before TTY injection:
case 'inject': {
  const sessionData = activeSessions.get(msg.sessionId);
  if (!sessionData || sessionData.failCount >= 3) {
    // Generic error — do not leak internal session state or file paths
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Session is no longer active',
      sessionId: msg.sessionId
    }));
    return;
  }
  // ... existing injection logic ...
}
```

**Modified watch_session (send pending prompts + support fromSeq):**
```javascript
case 'watch_session': {
  // ... existing watch logic ...

  const sessionData = activeSessions.get(sessionId);
  if (sessionData) {
    // Send pending prompts immediately (G1 — authoritative prompt recovery)
    if (sessionData.pendingPrompts.size > 0) {
      ws.send(JSON.stringify({
        type: 'pending_prompts',
        sessionId,
        prompts: Array.from(sessionData.pendingPrompts.values()),
        lastSeq: sessionData.lastBroadcastSeq
      }));
    }

    // If client provides fromSeq, send delta from recent events buffer
    if (msg.fromSeq != null) {
      const fromSeq = Math.max(0, Math.floor(Number(msg.fromSeq)) || 0);

      if (fromSeq > 0 && fromSeq <= sessionData.lastBroadcastSeq) {
        const delta = sessionData.recentEvents.filter(e => e.seq > fromSeq);
        if (delta.length > 0) {
          ws.send(JSON.stringify({
            type: 'session_delta',
            sessionId,
            events: delta,
            lastSeq: sessionData.lastBroadcastSeq
          }));
          // Skip full history — delta is sufficient
          return;
        }
      }
      // fromSeq too old (evicted from buffer) or invalid — fall through to existing history path
    }

    // ... existing sendRecentHistory / history flow ...
  }
}
```

**Client-side changes (connection.js):**
```javascript
// Track last received seq per session
let lastReceivedSeq = 0;

// On every message with seq field:
if (msg.seq != null) {
  if (msg.seq <= lastReceivedSeq) return; // Drop duplicate
  lastReceivedSeq = msg.seq;
}

// On watch_session, include fromSeq for delta replay:
ws.send(JSON.stringify({
  action: 'watch_session',
  sessionId: id,
  fromSeq: lastReceivedSeq > 0 ? lastReceivedSeq : undefined
}));

// Handle new message types:
case 'pending_prompts':
  // Restore pending prompts from server state
  msg.prompts.forEach(prompt => showPromptCard(prompt));
  break;

case 'session_delta':
  // Replay missed events
  msg.events.forEach(event => handleMessage(event));
  lastReceivedSeq = msg.lastSeq;
  break;

case 'session_suspect':
  // Show "connection unstable" warning + disable input
  // Use text label + icon (not color-only) for accessibility
  showSessionWarning('Session may be unavailable — input paused');
  disableSessionInput(); // Queue commands until session_alive or session_dead resolves
  break;

case 'session_alive':
  // Clear warning + re-enable input
  clearSessionWarning();
  enableSessionInput();
  break;
```

**Prompt state cleanup on session replacement:**
```javascript
// In session replacement handler:
// 1. Run synchronous liveness check on replacement candidate
const replacementAlive = await checkProcessAlive(replacementPid);
if (!replacementAlive) {
  // Replacement is also dead — don't chain failures
  broadcastToClients({ type: 'session_ended', sessionId: oldSessionId });
  return;
}

// 2. Clear old session's pending prompts before switching clients
const oldSessionData = activeSessions.get(oldSessionId);
if (oldSessionData) {
  oldSessionData.pendingPrompts.clear();
}

// 3. Proceed with session_replaced broadcast
```

**Post-answer prompt reconciliation:**
```javascript
// After processing a user's prompt response (inject/select_option):
// Re-send remaining pending prompts so client sees what's still pending
if (sessionData.pendingPrompts.size > 0) {
  ws.send(JSON.stringify({
    type: 'pending_prompts',
    sessionId,
    prompts: Array.from(sessionData.pendingPrompts.values()),
    lastSeq: sessionData.lastBroadcastSeq
  }));
}
```

**Prompt TTL cleanup (periodic):**
```javascript
// In the existing liveness check interval (runs every 15s):
// Expire prompts older than 10 minutes if no clients are watching
const PROMPT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const now = Date.now();
for (const [sessionId, sessionData] of activeSessions) {
  const hasWatchers = [...clients.values()].some(c => c.watchingSessions.has(sessionId));
  if (!hasWatchers && sessionData.pendingPrompts.size > 0) {
    for (const [promptId, prompt] of sessionData.pendingPrompts) {
      if (now - prompt.timestamp > PROMPT_TTL_MS) {
        sessionData.pendingPrompts.delete(promptId);
      }
    }
  }
}
```

## Implementation Steps

### Phase 1: Server-Side Foundation
1. **Verify existing dead session detection** — Read commit `ea2281c` to understand current liveness mechanism. Reuse or extend existing counter if one exists, rather than adding `failCount` as a parallel mechanism.
2. **Add new fields to activeSessions entries** — `pendingPrompts`, `lastBroadcastSeq`, `recentEvents`, `failCount` (or extend existing counter). Initialize in `watchSession()`.
3. **Modify `broadcastToClients`** — Inject seq from session's `lastBroadcastSeq`, push non-ephemeral events to `recentEvents` buffer (exclude `EPHEMERAL_TYPES`). Periodic compaction at cap+20.
4. **Add `updatePromptState()` inline function** — Define at module scope near session utilities (not buried in watcher callback). Call from watcher after parsing events. Track permission_request/ask_user_question → tool_result/user lifecycle.
5. **Modify liveness check** — Add failCount threshold (≥3 = dead, 1 = suspect broadcast). Remove immediate kill on first failure. Add prompt TTL cleanup (expire prompts >10min with no watchers).
6. **Add session ID validation to inject/select_option/escape handlers** — Reject commands for dead/replaced sessions with generic error message.
7. **Add post-answer prompt reconciliation** — After processing inject/select_option, re-send `pending_prompts` to client so remaining prompts are visible.
8. **Add replacement liveness pre-check** — Before broadcasting `session_replaced`, run synchronous liveness check on replacement candidate. If dead, broadcast `session_ended` instead.
9. **Modify `watch_session` handler** — Send `pending_prompts` message. Support `fromSeq` for delta replay from `recentEvents` buffer.
10. **Add cache-busting to served JS files** — Version query string on `<script>` tags so browser cache doesn't serve stale client code after server update.

### Phase 2: Client-Side Integration
11. **Modify `public/js/state.js`** — Add `lastReceivedSeq` tracking per session.
12. **Modify `public/js/connection.js`** — Drop messages with `seq <= lastReceivedSeq`. Include `fromSeq` on `watch_session`. Handle `pending_prompts`, `session_delta`, `session_suspect`, `session_alive` message types.
13. **Modify `public/js/prompts.js`** — Accept pending prompts from server `pending_prompts` message directly instead of scanning history. Remove fragile history-based prompt recovery. Add ARIA live region for prompt announcements (accessibility). Move focus to prompt card on arrival, return focus on dismiss.
14. **Modify `public/js/sessions.js`** — Show/clear "connection unstable" indicator for suspect/alive. Use text label + icon (not color-only) for session state indicators (accessibility). Disable input during suspect state, re-enable on alive/dead resolution. Add empty state for zero sessions: "No active Claude sessions detected — start a Claude session in your terminal to begin."

### Phase 3: Cleanup
15. **Remove client-side dedup hacks** — `shouldDedupeMessage`, `recentUserMessages` map, `trackSentMessage` (replaced by seq-based dedup).
16. **Remove `PERMISSION_CARD_DELAY_MS`** — Server tracks prompt lifecycle explicitly.
17. **Simplify `renderHistory`** — No longer needs to scan for unanswered prompts (server provides authoritative state).

## Affected Files

**No new files.**

**Modified files:**
- `server.js` — Add fields to activeSessions entries; modify `broadcastToClients` to inject seq; add `updatePromptState()` function; modify liveness check for failCount grace; add session validation to inject handlers; modify `watch_session` for pending prompts + fromSeq delta
- `lib/watcher.js` — Call `updatePromptState()` after parsing events; remove `pendingMainPermissions` deferred logic (replaced by server-side prompt tracking)
- `public/js/state.js` — Add `lastReceivedSeq` tracking
- `public/js/connection.js` — Seq-based dedup; `fromSeq` on watch; handle `pending_prompts`, `session_delta`, `session_suspect`, `session_alive`
- `public/js/prompts.js` — Accept prompts from server; remove history-based recovery; remove `PERMISSION_CARD_DELAY_MS`
- `public/js/sessions.js` — Session suspect/alive UI indicator; simplify `renderHistory`

**Untouched files:**
- `lib/log-parser.js` — Parsing logic unchanged
- `lib/command-injection.js` — TTY injection unchanged (validation added at caller level)
- `lib/session-discovery.js` — Discovery unchanged
- `public/js/ui.js`, `public/js/init.js` — No changes needed

## Acceptance Criteria
- [ ] Server assigns monotonic sequence numbers to all session events
- [ ] Client drops messages with `seq <= lastReceivedSeq` (no duplicates)
- [ ] Client reconnection after brief background shows pending prompts immediately
- [ ] Client reconnection with `fromSeq` receives delta from recent events buffer
- [ ] Client reconnection after server restart (fromSeq > lastBroadcastSeq) falls through to full history
- [ ] Permission requests that are auto-approved never appear as prompt cards
- [ ] Permission requests that need user input always appear as prompt cards
- [ ] After answering a prompt, remaining pending prompts are re-sent to client
- [ ] Opening multiple browser tabs shows no duplicate messages
- [ ] Session survives a brief Claude process restart (< 45s)
- [ ] Session correctly transitions to dead after 3 consecutive liveness failures
- [ ] `session_suspect` broadcast at first liveness failure; client disables input
- [ ] `session_alive` broadcast on recovery; client re-enables input
- [ ] Inject/select_option/escape rejected for dead/replaced sessions with generic error message
- [ ] Stale prompts cleared on session replacement
- [ ] Replacement liveness pre-check: dead replacement triggers `session_ended` not `session_replaced`
- [ ] Prompt TTL: prompts >10min with no watchers are expired and removed
- [ ] Ephemeral message types excluded from recentEvents replay buffer
- [ ] Empty state shown when no active sessions detected
- [ ] Session state indicators use text+icon (not color-only) for accessibility
- [ ] Prompt arrival announced via ARIA live region for screen readers
- [ ] JS files served with cache-busting version query strings
- [ ] Tests passing with required coverage

## Test Strategy

- **Unit tests (prompt state tracking):**
  - `updatePromptState()` adds permission_request to pendingPrompts Map
  - `updatePromptState()` removes on matching tool_result (by toolUseId)
  - `updatePromptState()` clears oldest ask_user_question on user event
  - Null/undefined event is no-op
  - Prompt with no toolUseId gets seq-based fallback ID

- **Unit tests (broadcast + seq):**
  - `broadcastToClients()` increments lastBroadcastSeq per session
  - `broadcastToClients()` includes seq in every message
  - `broadcastToClients()` stores non-ephemeral events in recentEvents buffer
  - `broadcastToClients()` excludes EPHEMERAL_TYPES from recentEvents
  - recentEvents compacts at cap+20 (periodic, not per-append)
  - recentEvents caps at 100 after compaction
  - Messages without sessionId still broadcast (no seq)

- **Unit tests (liveness grace):**
  - failCount increments on process-not-found
  - failCount resets on process-found
  - session_suspect broadcast at failCount === 1
  - session_alive broadcast when failCount resets from > 0
  - Dead declaration at failCount >= 3

- **Unit tests (inject-race guard):**
  - inject rejected when sessionId not in activeSessions
  - inject rejected when session failCount >= 3
  - select_option rejected for dead session
  - escape rejected for dead session
  - Client receives error message on rejection

- **Unit tests (prompt TTL):**
  - Prompts >10min with no watchers are expired
  - Prompts <10min are retained regardless of watchers
  - Prompts with active watchers are never expired regardless of age

- **Unit tests (replacement liveness pre-check):**
  - Live replacement → session_replaced broadcast
  - Dead replacement → session_ended broadcast (no session_replaced)

- **Unit tests (post-answer reconciliation):**
  - After inject response, remaining pendingPrompts re-sent to client
  - After select_option response, remaining pendingPrompts re-sent to client
  - If no remaining prompts, no pending_prompts message sent

- **Integration tests:**
  - Watcher parses log → updatePromptState → broadcastToClients with seq → client receives
  - Reconnection with fromSeq returns correct delta from recentEvents
  - Reconnection with stale fromSeq (evicted) falls through to full history
  - Reconnection after server restart (fromSeq > lastBroadcastSeq) → full history replay
  - Auto-approved permission: permission_request + tool_result in quick succession → no client prompt
  - Pending permission: permission_request with no tool_result → client receives via pending_prompts
  - Multi-prompt scenario: answer one → remaining prompts re-sent → client shows remaining
  - Session replacement: process dies → suspect → dead → replacement liveness check → session_replaced or session_ended
  - Session replacement: client inject for old session rejected with error
  - Prompt TTL: 10min-old prompt with no watchers → expired on next cleanup cycle

- **Edge cases:**
  - fromSeq as string/float/negative → coerced or rejected
  - fromSeq > lastBroadcastSeq (server restart) → fall through to history
  - fromSeq = 0 → treated as no cursor (full history path)
  - recentEvents empty (fresh session) → empty delta
  - Multiple pending prompts simultaneously (subagent + main)
  - Permission resolved between pending_prompts send and client rendering
  - Session replacement while prompts pending → prompts cleared
  - Replacement candidate immediately dead → session_ended, no loop
  - Ephemeral messages (session_status) NOT in recentEvents replay

- **Security tests:**
  - fromSeq validation: non-numeric values rejected
  - Inject/select_option/escape: dead session commands rejected
  - Error messages are generic (no internal state/paths leaked)
  - recentEvents capped at 100 (no unbounded growth)
  - Per-event size not enforced (documented accepted risk at ~1KB average)

## Security Review
- [x] Authentication/authorization — existing auth flow unchanged, new messages gated behind `authenticated` check
- [x] Input validation — `fromSeq` validated as non-negative integer via `Math.max(0, Math.floor(Number()) || 0)`
- [x] No hardcoded secrets
- [x] Inject-race mitigated — session ID + failCount validation before TTY injection (residual TOCTOU accepted for single-user local app)
- [x] Error messages — generic text only, no internal state/paths/PIDs leaked
- [x] Rate limiting — existing per-connection rate limit applies (verify during implementation)
- [x] Buffer capped — recentEvents limited to 100 entries, ephemeral types excluded
- [x] Prompt TTL — stale prompts expired after 10min with no watchers
- [ ] N/A — SQL injection (no database)
- [ ] N/A — XSS (no new HTML rendering)
- [ ] N/A — CSRF (WebSocket-only communication)

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| recentEvents memory with many sessions | Low | Low | Capped at 100 non-ephemeral events per session. At ~1KB/event = ~100KB per session. Acceptable. |
| Server restart loses all state | Med | Low | JSONL file is persistent source. Clients reconnect with stale fromSeq > lastBroadcastSeq, fall through to existing history path. Explicitly tested. |
| FIFO clearing for ask_user_question | Low | Med | AskUserQuestion prompts are rare and sequential in practice. Mitigated by post-answer prompt reconciliation: remaining prompts re-sent after each answer, so any incorrectly cleared prompt is immediately resurfaced. |
| iOS client doesn't understand new message types | Low | Low | New types (`pending_prompts`, `session_delta`, `session_suspect`, `session_alive`) are additive — iOS client ignores unknown message types. `seq` field is also additive. Update iOS client in coordinated deploy. |
| Prompt state drift from non-logged resolutions | Med | Med | If Claude Code resolves a prompt via mechanism not logged to JSONL, pendingPrompts won't know. Mitigated by existing 30s periodic claudeState sync + 10min prompt TTL. |
| Inject-race residual TOCTOU | Low | Low | Pre-check narrows window but doesn't eliminate it. Wrong target is always another Claude session (not arbitrary process). Accepted for single-user local app. |
| Browser cache serving stale JS | Med | Low | Cache-busting via version query string on script tags. |
| failCount conflicting with existing dead session detection | Med | Med | Must verify interaction with commit ea2281c during Phase 1 step 1. Reuse existing counter if available. |

## Rollback Plan
1. Revert `server.js` changes — removes new fields, seq injection, liveness grace, inject validation
2. Revert `lib/watcher.js` changes — restores pendingMainPermissions deferred logic
3. Revert `public/js/` changes — restores old dedup hacks, history scanning, PERMISSION_CARD_DELAY_MS
4. No files to delete (no new files were created)

## Past Learnings Applied
- **Chokidar Watcher Reliability** (`docs/solutions/integration-issues/chokidar-watcher-reliability.md`): Concurrency guard, fallback poll, drain loop. Unchanged — prompt tracking layers on top.
- **Permission System Deferral** (`docs/solutions/logic-errors/main-watcher-permission-suppression-hardcoded-allowlist-20260219.md`): Three-phase defer algorithm replaced by deterministic pendingPrompts Map tracking.
- **Permission Queue for Concurrent Subagents** (`docs/solutions/concurrency-issues/permission-queue-concurrent-subagents.md`): FIFO queue retained on client side, simplified by server providing authoritative state.
- **Server Modularization** (`docs/solutions/integration-issues/server-modularization-factory-pattern-20260218.md`): Factory pattern with `deps` object. New inline functions follow same pattern.

## Dependencies
- No external dependencies added
- No new files created
- Existing `ws` library sufficient
- iOS client update needed (coordinated deploy) to handle new message types
