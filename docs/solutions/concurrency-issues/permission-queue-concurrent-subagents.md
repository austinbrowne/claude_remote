---
title: "Permission Queue for Concurrent Subagent Permissions"
category: concurrency-issues
subcategory: queue-architecture
tags:
  - permissions
  - queue
  - subagents
  - concurrent
  - fifo
  - swift
  - observable
  - prompt-service
components:
  - PromptService.swift:handlePermissionRequest
  - PromptService.swift:enqueuePrompt
  - PromptService.swift:cancelPendingPermission
  - PromptService.swift:cascadeAlwaysAllow
  - AppCoordinator.swift:subagentOutput
  - PromptCardView.swift
symptoms:
  - permissions-silently-overwritten
  - subagent-permissions-never-shown
  - sessions-hang-waiting-for-response
  - only-one-permission-visible-at-a-time
root_causes:
  - single-prompt-architecture
  - subagent-output-suppressed
  - single-delay-timer-overwrites-previous
  - double-dismissal-on-tool-result
  - dictionary-iteration-order-not-fifo
severity: high
date_solved: 2026-02-01
---

# Permission Queue for Concurrent Subagent Permissions

## Problem

When Claude Code spawns many subagents in parallel (planning, brainstorming, reviewing), each can request permissions (Bash, Write, Edit). The iOS app handled exactly ONE permission at a time — new ones silently overwrote the previous. Additionally, subagent permissions were completely suppressed. Sessions would hang indefinitely waiting for responses the user never saw.

### Symptoms

- Only one permission card visible even when multiple tools need approval
- Subagent-originated permissions never appear (sessions hang)
- Rapidly arriving permissions cause earlier ones to disappear
- "Allow Always" on one permission doesn't clear duplicates

### Root Causes

**1. Single-prompt architecture.** `PromptService.currentPrompt` was a single `PromptItem?`. Each new `handlePermissionRequest()` called `cancelPendingPermission()` which cancelled the previous pending item before starting a new 500ms delay.

**2. Subagent output suppressed.** `AppCoordinator.routeMessage()` had `case .subagentOutput: break` — all subagent output was dropped. The server sends subagent `permission_request` items wrapped in `subagent_output` messages, so they never reached `PromptService`.

**3. Single delay timer.** One `delayTask: Task<Void, Never>?` meant each new permission cancelled the previous timer, even if they were for different tools from different subagents.

## Solution

### A. Replace single prompt with FIFO queue

```swift
// Before: single prompt
public private(set) var currentPrompt: PromptItem?
private var pendingPermission: PromptItem?
private var delayTask: Task<Void, Never>?

// After: queue with per-item state
public private(set) var promptQueue: [PromptItem] = []
public var currentPrompt: PromptItem? { promptQueue.first }  // computed
private var pendingPermissions: [String: (item: PromptItem, order: Int)] = [:]
private var delayTasks: [String: Task<Void, Never>] = [:]
private var arrivalCounter: Int = 0
```

Each permission gets its own independent 500ms delay timer, keyed by `toolUseId`. A monotonic `arrivalCounter` tracks arrival order.

### B. Route subagent permissions

```swift
case .subagentOutput(let agentId, _, let data):
    if let data, (data.type == "permission_request" || data.type == "ask_user_question") {
        let desc = state.activeSubagents[agentId]?.description
        promptService.handleClaudeOutput(data, agentDescription: desc)
    }
```

### C. Sorted insertion for FIFO ordering

Dictionary-keyed pending permissions don't preserve insertion order. When multiple 500ms timers fire, Task scheduling determines execution order — not arrival order. Fix: store `arrivalOrder` on each `PromptItem` and use sorted insertion:

```swift
private func enqueuePrompt(_ prompt: PromptItem) {
    if prompt.arrivalOrder > 0 {
        let insertAt = promptQueue.firstIndex(where: { $0.arrivalOrder > prompt.arrivalOrder })
            ?? promptQueue.count
        promptQueue.insert(prompt, at: insertAt)
    } else {
        promptQueue.append(prompt)
    }
}
```

### D. Prevent double-dismissal on tool_result

When `tool_result` arrives, `cancelPendingPermission` (removes from pending) and `dismissPermission` (removes from queue) must not both fire. The first removes the pending item, but `dismissPermission`'s fallback ("dismiss head if it's a permission") then removes an unrelated item.

Fix: `cancelPendingPermission` returns `Bool`. Only call `dismissPermission` if it didn't find a match:

```swift
case "tool_result":
    if !cancelPendingPermission(toolUseId: data.toolUseId) {
        dismissPermission(toolUseId: data.toolUseId)
    }
```

### E. "Allow Always" cascade

After responding "always" for a tool, proactively remove all other permissions for the same tool from both the queue and pending timers:

```swift
private func cascadeAlwaysAllow(tool: String) {
    for (key, pending) in pendingPermissions {
        if case .permission(let t, _, _) = pending.item.kind, t == tool {
            delayTasks[key]?.cancel()
            pendingPermissions.removeValue(forKey: key)
        }
    }
    promptQueue.removeAll { item in
        if case .permission(let t, _, _) = item.kind { return t == tool }
        return false
    }
}
```

### F. dismiss() must cancel multiSelectTask unconditionally

`respondMultiSelect` calls `dismissHead()` before starting its task. When the user later calls `dismiss()`, the queue is empty, so `dismissHead()` returns early without cancelling `multiSelectTask`. Fix: cancel explicitly in `dismiss()` regardless of queue state.

## Key Gotchas

1. **Dictionary iteration order is not insertion order.** Swift dictionaries are unordered. If you use a `[String: Item]` dict as a pending queue and then iterate/drain it, items come out in hash order, not FIFO. Use a monotonic counter and sorted insertion.

2. **Async Task scheduling is not deterministic.** Multiple `Task { try await Task.sleep(for: .milliseconds(500)) }` created synchronously on `@MainActor` may fire in any order. Don't rely on creation order for execution order.

3. **`try? await Task.sleep` swallows CancellationError.** The sleep returns silently on cancel, but `Task.isCancelled` is `true` on the next check. Always guard after sleep.

4. **Guard-early in dismissHead breaks callers.** If `dismissHead()` has `guard !promptQueue.isEmpty else { return }`, callers that need side effects (like cancelling multiSelectTask) must handle the empty-queue case themselves.

5. **Tuple access after dict value change.** When changing `pendingPermissions` from `[String: PromptItem]` to `[String: (item: PromptItem, order: Int)]`, every access like `item.toolUseId` must become `item.item.toolUseId`. The compiler doesn't always catch this if field names coincidentally match tuple labels.

## Prevention

- When designing state that holds multiple concurrent items, start with an ordered collection (array), not a dictionary. Use a dictionary only for O(1) lookup, and pair it with an ordering mechanism.
- When an operation has two phases (cancel pending OR dismiss from queue), make them mutually exclusive. Return a `Bool` from the first to gate the second.
- Test concurrent scenarios explicitly: create N items rapidly, verify ordering after delay, verify targeted dismissal doesn't affect siblings.

## Related

- `docs/solutions/integration-issues/claude-code-remote-monitoring.md` — Original 500ms delay pattern
- `docs/solutions/concurrency-issues/trigger-word-phase5-audio-arbitration.md` — Per-item delay timers pattern, generation counters
- `docs/solutions/code-quality/phase-8-review-fixes-race-security-perf.md` — Session switch cleanup patterns
