

---
title: "Message Delivery Confirmation"
type: feat
date: 2026-02-01
---

# Message Delivery Confirmation

## Overview

When a user sends a message from the iOS app, there is no feedback that the message actually reached the terminal. The message appears locally (optimistic UI), but if injection fails silently — wrong TTY, session died, AppleScript error — the user stares at a chat with their message and nothing happening. The existing spinner verb ("Thinking...", "Working...") satisfies the "Claude is acting" signal, but only when it arrives promptly. There's a gap between "I tapped send" and "something is happening."

## Problem Statement

The feedback gap has two parts:

1. **No delivery confirmation.** The server already sends `inject_result` with `success: true/false`, but the iOS app ignores it (`case .injectResult, .escapeResult: break`). A failed injection is completely invisible.

2. **No "received" signal.** Even on success, there can be 1-5 seconds before Claude emits a `progress` entry (which becomes the spinner verb). During that window the user doesn't know if their message went through or if the app is broken.

## Proposed Solution

Two lightweight indicators, no new UI components:

### Signal 1: Immediate "Sending..." activity bar on send

When the user taps send, immediately set `state.currentActivity = "Sending..."`. This reuses the existing activity bar (spinner + text above InputBarView). It shows instantly, before any server round-trip.

This gets replaced naturally when either:
- `inject_result` arrives (success -> clear or keep for spinner; failure -> show error)
- A `status_update` arrives from Claude ("Thinking...", etc.)
- An `assistant` or `tool_result` message arrives (clears activity)

### Signal 2: Handle inject_result for failure feedback

On `inject_result(success: false)`, show a toast with the error and clear the activity bar. On `inject_result(success: true)`, update the activity to "Delivered" briefly (or let the next spinner verb overwrite it naturally).

### Flow

```
User taps send
  -> Message appears in chat (existing optimistic UI)
  -> Activity bar shows "Sending..." with spinner (NEW)
  -> Haptic fires (existing)

Server receives inject
  -> inject_result { success: true } sent back

iOS receives inject_result
  -> success: activity bar shows "Delivered" (NEW)
     (will be overwritten by Claude's spinner verb within ~1-3s)
  -> failure: toast "Failed to send: <error>", clear activity (NEW)

Claude starts processing
  -> status_update "Thinking..." overwrites activity bar (existing)
```

## Acceptance Criteria

- [ ] Tapping send immediately shows "Sending..." in the activity bar
- [ ] Successful inject_result briefly shows "Delivered" (overwritten by next status_update)
- [ ] Failed inject_result shows error toast and clears activity bar
- [ ] Existing spinner verb behavior unchanged
- [ ] No new UI components — reuses activity bar and toast system

## Technical Approach

### Files to modify

| File | Change |
|------|--------|
| `InputBarView.swift` (~line 211) | Set `state.currentActivity = "Sending..."` right after `appendMessage` |
| `AppCoordinator.swift` (~line 441) | Replace `break` with inject_result handler: success sets `"Delivered"`, failure shows toast + clears activity |

### InputBarView.swift

In `send()`, after the local message is appended:

```swift
// Show the message locally immediately
let userMsg = Message(type: .user, content: trimmed)
state.appendMessage(userMsg)
state.currentActivity = "Sending..."       // <-- NEW
coordinator.injectCommand(trimmed, sessionId: sessionId)
```

### AppCoordinator.swift

Replace the silent `break`:

```swift
case .injectResult(let success, let error):
    if success {
        // Only set "Delivered" if we're still showing "Sending..."
        // (avoids overwriting a spinner verb that arrived faster)
        if state.currentActivity == "Sending..." {
            state.currentActivity = "Delivered"
        }
    } else {
        state.currentActivity = nil
        state.showToast(
            error ?? "Failed to send message",
            icon: "exclamationmark.triangle",
            style: .error
        )
    }
```

### Edge cases

- **Fast Claude response**: If a `status_update` arrives before `inject_result`, the activity already shows "Thinking..." — the `inject_result` handler checks for `"Sending..."` and won't overwrite it.
- **Disconnected**: WebSocket send fails silently. The "Sending..." will linger. The existing disconnect banner + auto-reconnect handles this. Could add a timeout to clear stale "Sending..." after 10s, but that's an optimization — the disconnect banner already signals the problem.
- **Escape while sending**: User taps escape, which clears the queue. Activity should be cleared by the next status update or session status change. No special handling needed.

## What This Does NOT Do

- No message-level delivery indicators (checkmarks, gray-to-blue transitions). That would require tracking individual message IDs through the inject -> echo lifecycle, which is over-engineered for this use case.
- No retry mechanism. If injection fails, the user sees the error and can resend manually.
- No change to the server. `inject_result` is already sent correctly.

## References

- `InputBarView.swift:198-218` — send() function
- `AppCoordinator.swift:441-442` — current silent inject_result handler
- `ContentView.swift:143-149` — activity bar display
- `AppState.swift:97` — `currentActivity` property
