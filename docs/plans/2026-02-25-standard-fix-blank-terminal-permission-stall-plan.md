---
title: Fix Blank Terminal After Prompt & Permission Queue Stall
status: draft
tier: standard
created: 2026-02-25
tags: [bug-fix, watcher, permissions, iOS]
---

# Fix Blank Terminal After Prompt & Permission Queue Stall

## Problem Statement

Two critical bugs:

1. **Blank terminal after sending prompt**: User sends a prompt from iOS, but the response never appears. Requires reloading the session to see it. The response EXISTS in the JSONL but real-time broadcast failed to deliver it.

2. **Permission queue stall with parallel tasks**: Three WebFetch permissions arrive (from simultaneous subagent tasks). Only one permission card appears on iOS. After approving it, the queue stalls — no more permissions appear.

## Root Cause Analysis

### Bug 1: Blank Terminal

No single definitive root cause found, but several fragile paths:

- **Race condition**: The inject async IIFE in `server.js:556` isn't awaited. If inject completes but the response arrives during a critical window (e.g., watcher `processing` flag is true from a concurrent poll), the response could be missed until the next poll cycle (2s fallback).
- **Silent WebSocket disconnection**: No keepalive/heartbeat mechanism. If the WebSocket drops silently after injection, responses are broadcast but never delivered.
- **iOS state mismatch**: If `state.currentSessionId` is nil or doesn't match when `claude_output` arrives, the message is silently dropped (AppCoordinator.swift:320).

### Bug 2: Permission Queue Stall

Fundamental timing mismatch between iOS queue management and Claude Code's sequential permission handling:

1. Server broadcasts 3 subagent permission_requests to iOS (before our auto-approve fix was deployed, OR if the fix's TTY injection fails)
2. iOS PromptService queues all 3, shows #1
3. User taps Allow → iOS sends inject "y" AND immediately calls `dismissHead()` → shows #2
4. **But Claude Code processes permissions SEQUENTIALLY.** Permission #2 hasn't appeared in the terminal yet — tool #1 is still running
5. User taps Allow on #2 → inject "y" arrives at terminal → **no permission prompt is active** → "y" becomes stray input
6. Queue appears stuck because the injected "y" didn't answer a real prompt

Additional factor: our recent subagent auto-approve writes `y\n` to `sessionData.session.tty` (the main session's TTY). If Claude Code uses a different mechanism for subagent permission (e.g., inter-process pipes rather than TTY input), the auto-approve silently fails.

## Solution

### Part A: Fix Permission Queue (Server-side sequential gating)

**Approach**: Don't broadcast all permissions at once. Gate permission delivery so iOS only gets the NEXT permission after the PREVIOUS one is resolved.

**Server changes** (`lib/watcher.js`):
- Add a `permissionGate` to the main session watcher — a queue that releases one permission at a time
- When a `permission_request` arrives (after deferred filter), add to gate queue. Only broadcast the HEAD item
- When a `tool_result` or `permission_resolved` arrives matching the head item's `toolUseId`, remove it and broadcast the NEXT queued item
- Fallback: if no resolution arrives within 30 seconds, broadcast the next item anyway (timeout safety)

This ensures iOS only ever has ONE active permission at a time, matching Claude Code's sequential model.

**Files changed:**
- `lib/watcher.js` — Add `pendingPermissionGate` array, gate logic in processLogChanges and deferred flush

### Part B: Subagent Auto-Approve Reliability

**Approach**: Improve the TTY auto-approve and add fallback mechanisms.

**Changes:**
1. **Use injectCommandToTty (AppleScript) instead of raw fsp.appendFile** for subagent auto-approvals. The AppleScript approach is proven for regular injects — use the same mechanism. This ensures the input reaches the correct process via iTerm's keystroke simulation.
2. **Add verification**: After auto-approve, check if a `tool_result` appears within 5 seconds. If not, log a warning (diagnostic breadcrumb).
3. **Keep the catch-up replay filter** in `sendActiveSubagents` (already done).
4. **Keep iOS suppression** of subagent permission routing (already done).

**Files changed:**
- `lib/watcher.js` — Switch from `fsp.appendFile('/dev/tty')` to `injectCommandToTty()` in subagent auto-approve
- `server.js` — Export or pass `injectCommandToTty` dependency to watcher

### Part C: Blank Terminal Diagnostics

**Approach**: Add lightweight breadcrumb logging at key points in the inject→response pipeline.

**Server-side:**
1. Log when inject starts and completes (with session ID and TTY)
2. Log when watcher broadcasts a `claude_output` with type `assistant` (the response)
3. Log when broadcastToClients sends to each client (with readyState)

**iOS-side:**
4. Log when `inject_result` arrives (confirms inject succeeded)
5. Log when `claude_output` arrives with type `assistant` (confirms response received)
6. Log if `currentSessionId` doesn't match incoming `sessionId` (the silent drop condition)

**WebSocket keepalive:**
7. Add ping/pong heartbeat every 30 seconds. If pong isn't received within 10 seconds, force reconnect. This catches silent disconnections.

**Files changed:**
- `server.js` — Add console.log breadcrumbs, WebSocket ping interval
- `lib/watcher.js` — Log on assistant broadcast
- `ClaudeRemote/Sources/ClaudeRemote/Services/AppCoordinator.swift` — Log session ID mismatches
- `ClaudeRemote/Sources/ClaudeRemote/Services/WebSocketService.swift` — Handle pong, force reconnect on timeout

## Implementation Order

1. **Part A** (permission gate) — Fixes the user-visible stall, most impactful
2. **Part B** (auto-approve reliability) — Ensures subagent permissions never reach user
3. **Part C** (diagnostics) — Helps diagnose blank terminal if it recurs

## Testing

- **Permission gate**: Unit test with mock items — 3 sequential permission_requests should only broadcast 1 at a time, advancing on tool_result
- **Auto-approve**: Integration test — subagent permission_request followed by tool_result after inject
- **Diagnostics**: Manual testing — send prompt, verify log breadcrumbs appear in correct order
- **Swift tests**: Ensure existing 543 tests pass
- **Node tests**: Ensure existing 286 tests pass + new gate tests

## Risk Assessment

- **LOW**: Part C (diagnostics) — logging only, no behavior change
- **MEDIUM**: Part A (permission gate) — changes permission delivery timing. Must handle edge cases: reconnection mid-gate, session switch, multiple clients watching same session
- **LOW**: Part B (auto-approve) — using proven injection mechanism instead of raw TTY write
