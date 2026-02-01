---
title: "fix: Subagent permission request flooding freezes iOS app"
type: fix
date: 2026-02-01
---

# fix: Subagent Permission Request Flooding Freezes iOS App

## Overview

When Claude Code spawns multiple parallel subagents (e.g., via Task tool), each subagent generates permission requests (Bash, Read, Write, etc.). These `subagent_output` messages with `type: "permission_request"` are broadcast **completely unthrottled** from `server.js`. On iOS, each triggers an independent 500ms delay task. When 10+ arrive within milliseconds, all delay tasks fire simultaneously, causing bulk queue insertions and a SwiftUI `@Observable` re-render storm that freezes the UI. The app hangs showing "waiting for output" because the main thread is blocked.

## Root Cause Analysis

Two layers are broken:

### Server Side (`server.js`)
- Commit `0004c5b` added throttling for cosmetic `subagent_tool` messages (capped at 1/500ms per agent)
- But actual `subagent_output` messages containing `permission_request` data are **never throttled** — they broadcast immediately
- A single subagent can generate 10+ permission requests in <1ms, all sent to the WebSocket at once

### iOS Side (`PromptService.swift`)
- Each permission creates an **independent** `Task.sleep(500ms)` delay task
- 10 permissions arriving at T=0ms create 10 parallel sleep tasks that ALL fire at T=500ms
- Each fires `enqueuePrompt()` → modifies `@Observable` `promptQueue` → triggers SwiftUI re-render
- 10 rapid mutations = 10 re-renders queued on main thread = UI freeze
- No queue size cap — queue grows unbounded
- No coalescing — each permission processed independently

## Existing Infrastructure (No Changes Needed)

| Component | Status |
|-----------|--------|
| `WebSocketMessage.swift` | Already decodes `subagent_output` with `ClaudeOutputData` correctly |
| `AppCoordinator.swift` routing | Already routes `permission_request` and `ask_user_question` to PromptService |
| `PromptCardView.swift` | Already caps visible cards at 3 with "+N more" overflow — UI is fine |
| Dismiss button | Already exists on permission cards (commit `0004c5b`) |
| `tool_result` auto-dismiss | Already cancels pending + dismisses queued permissions on tool completion |

## Fix: Two-Layer Throttling

### Layer 1: Server-Side Permission Throttling (`server.js`)

**Goal:** Prevent burst-broadcasting 10+ permission requests in <1ms.

**Approach:** Global permission broadcast throttle (not per-agent — the total volume matters, not per-source).

Add to server.js:

```javascript
// Near existing subagentToolThrottles (line ~50)
let lastPermissionBroadcastTime = 0;
const PERMISSION_THROTTLE_MS = 150;
const pendingPermissionBroadcasts = [];
let permissionFlushTimer = null;
```

In the `subagent_output` broadcast path (around line 754-765), wrap permission broadcasts:

```javascript
if (item.type === 'permission_request' || item.type === 'ask_user_question') {
    const now = Date.now();
    if (now - lastPermissionBroadcastTime >= PERMISSION_THROTTLE_MS) {
        lastPermissionBroadcastTime = now;
        broadcastToClients({ type: 'subagent_output', sessionId, agentId, data: item });
    } else {
        // Queue and flush after throttle window
        pendingPermissionBroadcasts.push({ type: 'subagent_output', sessionId, agentId, data: item });
        if (!permissionFlushTimer) {
            permissionFlushTimer = setTimeout(() => {
                for (const msg of pendingPermissionBroadcasts) {
                    broadcastToClients(msg);
                }
                pendingPermissionBroadcasts.length = 0;
                permissionFlushTimer = null;
                lastPermissionBroadcastTime = Date.now();
            }, PERMISSION_THROTTLE_MS);
        }
    }
} else {
    // Non-permission subagent_output — send immediately (already throttled elsewhere for tool msgs)
    broadcastToClients({ type: 'subagent_output', sessionId, agentId, data: item });
}
```

**Why 150ms?** Fast enough that a single permission still appears near-instantly. Slow enough that a burst of 10 gets spread out over ~1.5s instead of arriving at once.

**Important:** Permissions are never dropped — only delayed. All queued permissions flush on the next timer tick.

### Layer 2: iOS Coalescing Timer (`PromptService.swift`)

**Goal:** Replace per-permission delay tasks with a single coalescing timer that batches arrivals.

**Current (broken) pattern:**
```swift
// Each permission creates its own sleep task
delayTasks[pendingKey] = Task {
    try? await Task.sleep(for: .milliseconds(500))
    enqueuePrompt(for: pendingKey)  // Each fires independently
}
```

**New pattern — single coalescing timer:**

Replace the per-permission `delayTasks` dictionary and individual sleep tasks with:

```swift
// Replace these:
// private var delayTasks: [String: Task<Void, Never>] = [:]

// With:
private var coalesceTask: Task<Void, Never>?
private static let coalesceDelay: Duration = .milliseconds(300)
```

Modify `handlePermissionRequest()` to store in `pendingPermissions` (unchanged) but use a single coalescing timer:

```swift
private func scheduleCoalescedEnqueue() {
    coalesceTask?.cancel()
    coalesceTask = Task { @MainActor in
        try? await Task.sleep(for: Self.coalesceDelay)
        guard !Task.isCancelled else { return }
        flushPendingPermissions()
    }
}

private func flushPendingPermissions() {
    let sorted = pendingPermissions
        .sorted { $0.value.order < $1.value.order }
    for (key, _) in sorted {
        enqueuePrompt(for: key)
    }
}
```

**Why this fixes the render storm:** Instead of 10 independent tasks each calling `enqueuePrompt()`, a single timer fires once and inserts all pending items in one batch. SwiftUI coalesces the mutations into a single render pass.

### Layer 3: Queue Size Cap (`PromptService.swift`)

Add a max queue size to prevent unbounded growth:

```swift
private static let maxQueueSize = 20

private func enqueuePrompt(for key: String) {
    guard let entry = pendingPermissions.removeValue(forKey: key) else { return }
    // ... existing insertion logic ...

    // Cap queue size — drop oldest non-head items
    while promptQueue.count > Self.maxQueueSize {
        promptQueue.remove(at: 1)  // Keep head (index 0), drop next oldest
    }
}
```

### Layer 4: Notification Dedup (`AppCoordinator.swift`)

Suppress duplicate notifications for burst permission arrivals:

```swift
// Add near existing state
private var lastPermissionNotifyTime: Date = .distantPast

// In routeMessage(), case .subagentOutput:
if let data, (data.type == "permission_request" || data.type == "ask_user_question") {
    let desc = state.activeSubagents[agentId]?.description
    promptService.handleClaudeOutput(data, agentDescription: desc)

    #if os(iOS)
    // Only notify once per 2 seconds for permission bursts
    let now = Date()
    if now.timeIntervalSince(lastPermissionNotifyTime) >= 2.0 {
        lastPermissionNotifyTime = now
        HapticService.medium()
        // ... notification logic
    }
    #endif
}
```

## Files to Modify

| File | Change |
|------|--------|
| `server.js` | Add global permission broadcast throttle (~150ms) with queue+flush |
| `PromptService.swift` | Replace per-permission delay tasks with single coalescing timer; add queue size cap |
| `AppCoordinator.swift` | Add notification dedup for permission bursts (2s cooldown) |

## Edge Cases

| Case | Handling |
|------|----------|
| Single permission (no burst) | Server sends immediately (under throttle window). iOS coalesce timer fires after 300ms — same UX as current 500ms delay but faster. |
| 10 permissions in 1ms | Server sends 1st immediately, queues 9, flushes after 150ms. iOS collects all into single coalesce batch. One render pass. |
| Permission arrives while user is responding to another | Already handled — queue is FIFO, user responds to head item, next appears. |
| `tool_result` arrives during coalesce window | `cancelPendingPermission()` removes from `pendingPermissions` before flush — permission never appears. |
| Session switch during burst | `beginSessionSwitch` clears queue + cancels `coalesceTask`. Clean slate. |
| Queue hits 20-item cap | Oldest non-head items dropped. User still sees current + next 2 + overflow count. |

## Acceptance Criteria

- [ ] `swift build` passes
- [ ] `swift test` passes (372+ tests)
- [ ] Single permission appears within ~300ms (no regression)
- [ ] 10 simultaneous permissions don't freeze UI — they trickle in over ~1.5s
- [ ] Answering a permission dismisses it and shows next in queue (existing behavior preserved)
- [ ] `tool_result` still auto-dismisses matching permissions
- [ ] Session switch clears all pending + queued permissions
- [ ] No duplicate haptic/notification spam during bursts
- [ ] Queue never exceeds 20 items

## Testing Strategy

### Manual Tests
1. Start a Claude Code session that spawns 3+ parallel Task agents
2. Each agent should request Bash/Read/Write permissions
3. Verify app doesn't freeze — permissions appear smoothly
4. Answer permissions one by one — verify FIFO ordering
5. Switch sessions during a burst — verify clean reset

### Unit Tests (PromptService)
- Test coalescing: add 5 permissions rapidly, verify single flush after delay
- Test queue cap: add 25 permissions, verify queue stays at 20
- Test cancellation: add permission, then cancel via `tool_result` before coalesce fires
- Test session reset: add permissions, call clear, verify coalesceTask cancelled

## References

- Existing fix commit: `0004c5b` (throttle subagent messages, fix task list, add prompt dismiss button)
- Learning: `docs/solutions/performance-issues/subagent-tool-flooding-and-task-id-mapping.md`
- Learning: `docs/solutions/concurrency-issues/permission-queue-concurrent-subagents.md`
