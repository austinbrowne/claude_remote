---
module: "WebSocket/Reconnection"
date: 2026-03-16
problem_type: best_practice
component: realtime
symptoms:
  - "Duplicate messages appearing after reconnect"
  - "Seq watermark regression causing replay of already-seen events"
  - "State corruption when session switch overlaps with message processing"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [websocket, sequence, dedup, reconnection, delta-replay, watermark, session-management, ios, swift]
language: swift
framework: swiftui
---

# WebSocket Sequence Dedup & Watermark Patterns

## Problem

When implementing sequence-based message deduplication and delta replay for WebSocket reconnection, several subtle patterns can cause correctness issues:

1. **Off-by-one on initial seq**: Using `seq <= lastReceivedSeq` with `lastReceivedSeq = 0` silently drops `seq=0` messages. Must verify server starts seq at 1, or use a sentinel like -1.

2. **Watermark regression**: When multiple message types (`session_delta`, `pending_prompts`) both carry a `lastSeq` field and update the same watermark, using plain assignment (`=`) instead of `max()` can regress the watermark below a value set by another message type.

3. **Session guard asymmetry**: Accepting messages for both `currentSessionId` and `pendingSessionId` is correct for prompt recovery (prompts arrive during switch), but seq watermark updates must only apply to the confirmed current session.

## Environment

- iOS SwiftUI app communicating with Node.js WebSocket server
- Server uses monotonic `++lastBroadcastSeq` (starts at 0, first broadcast gets seq=1)
- Client tracks `lastReceivedSeq` for dedup and sends `fromSeq` on reconnect

## Symptoms

- Messages silently dropped on first connection (if server sent seq=0)
- After reconnect, client replays events it already processed (watermark regressed)
- State mutations from a pending session's events corrupt the current session

## Solution

### 1. Document the server seq contract

```swift
// Seq-based dedup: drop messages already processed.
// Server starts seq at 1; lastReceivedSeq starts at 0 so first message always passes.
if let seq {
    if seq <= state.lastReceivedSeq { return }
    state.lastReceivedSeq = seq
}
```

### 2. Always use max() for watermark updates

```swift
// WRONG: plain assign can regress watermark
state.lastReceivedSeq = lastSeq

// RIGHT: max() prevents regression from out-of-order message types
state.lastReceivedSeq = max(state.lastReceivedSeq, lastSeq)
```

### 3. Guard state mutations to confirmed session only

```swift
// Accept prompts for current OR pending session (needed during switch)
guard sessionId == state.currentSessionId || sessionId == state.pendingSessionId else { break }

// But only update seq watermark for the CONFIRMED current session
if let lastSeq, sessionId == state.currentSessionId {
    state.lastReceivedSeq = max(state.lastReceivedSeq, lastSeq)
}
```

### 4. Restrict delta replay to confirmed session

```swift
// session_delta should only process for currentSessionId (not pending)
// to avoid corrupting state before session switch completes
guard sessionId == state.currentSessionId else { break }
```

## Why This Works

- `max()` makes watermark updates idempotent regardless of message ordering
- The session guard prevents cross-session state pollution during the brief switch window
- Documenting the seq=1 contract makes the `<=` check's correctness explicit

## Gotchas

- If you mirror seq state across two objects (e.g., `AppState.lastReceivedSeq` and `WebSocketService.lastReceivedSeq`), every update site must sync both. Extract a helper method to prevent drift.
- When re-decoding events from `session_delta`, use `decodeIfPresent` instead of `try?` — the former throws on type mismatch (catches real errors) while the latter silently returns nil for any failure.
- Events decoded from `session_delta` have no envelope `seq` — they bypass the outer dedup guard. This is correct (they're already validated by the server) but the recursive path should be tested.

## Prevention

- Add tests for: seq=0 handling, out-of-order seq (10 then 5), watermark non-regression, session guard behavior
- When porting dedup patterns between web and mobile clients, verify the server's seq starting value — don't assume
- Review all paths that update shared watermarks for consistent use of `max()`

## Related Issues

- Web client (`connection.js`) uses the same `<= lastReceivedSeq` pattern with the same server contract
