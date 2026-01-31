---
title: "Swift structured concurrency pitfalls in @Observable classes"
date: 2026-01-30
category: logic-errors
tags: [swift, swiftui, structured-concurrency, task-cancellation, retain-cycle, observable]
module: ClaudeRemote iOS App
symptoms:
  - "Multi-select injections continue after prompt dismissal (fire-and-forget Task)"
  - "Cancelled Tasks continue executing due to try? swallowing CancellationError"
  - "AppCoordinator retained by PromptService closure (retain cycle)"
  - "Multi-question stepping state never advances (view dismissed before index increments)"
  - "Type safety lost with String instead of SessionStatus enum"
severity: high
root_cause: "Untracked Task handles, implicit CancellationError suppression by try?, strong closure captures in @Observable init, dead state from incorrect view lifecycle assumptions"
---

# Swift Structured Concurrency Pitfalls in @Observable Classes

## Context

During Phase 3 code review of ClaudeRemote (iOS native SwiftUI app), a 6-agent parallel review found 12 issues (2 P1, 5 P2, 5 P3). The most critical were all related to Swift structured concurrency and @Observable class patterns. Fixed using the [swarm-fix](/.claude/skills/swarm-fix/SKILL.md) parallel agent pattern.

## Problem

Five distinct pitfalls emerged from combining `@Observable` classes with Swift structured concurrency:

### 1. Fire-and-forget Task (P1)

`PromptService.respondMultiSelect` created an untracked `Task` that injected selections with 1-second delays. If the user dismissed or a new prompt arrived, the task kept injecting into the terminal.

```swift
// BAD: Task reference is lost immediately
public func respondMultiSelect(_ selections: [String]) {
    Task { @MainActor [send] in
        for selection in selections {
            send(.inject(command: selection, sessionId: sid))
            try? await Task.sleep(for: .seconds(1))
        }
        send(.inject(command: "", sessionId: sid))
    }
}
```

### 2. try? swallows CancellationError (P1)

Even after storing the task handle and calling `.cancel()`, the loop continued because `try? await Task.sleep` catches `CancellationError` silently. The next iteration ran anyway.

### 3. Retain cycle between @Observable classes (P2)

`AppCoordinator` held `PromptService` which held a `send` closure that captured `AppCoordinator` strongly:

```
AppCoordinator --[let]--> PromptService --[closure]--> AppCoordinator
```

### 4. Dead view state from lifecycle mismatch (P1)

`QuestionCardContent` tracked `@State private var currentQuestionIndex = 0` to step through multi-question flows. But `PromptService.respond(text:)` calls `dismissPrompt()`, which removes the view entirely. The index never advances.

### 5. String-typed API losing type safety (P2)

`handleSessionStatus(_ status: String)` used `status == "processing"` — no compile-time check for typos.

## Solution

### Fix 1: Store task handle + cancellation

```swift
private var multiSelectTask: Task<Void, Never>?

public func respondMultiSelect(_ selections: [String]) {
    guard let sid = sessionId else { return }
    dismissPrompt()

    multiSelectTask = Task { @MainActor [sendHandler] in
        for selection in selections {
            guard !Task.isCancelled else { return }
            sendHandler?(.inject(command: selection, sessionId: sid))
            try? await Task.sleep(for: .seconds(1))
        }
        guard !Task.isCancelled else { return }
        sendHandler?(.inject(command: "", sessionId: sid))
    }
}

private func dismissPrompt() {
    currentPrompt = nil
    messagesSincePrompt = 0
    cancelPendingPermission()
    multiSelectTask?.cancel()
    multiSelectTask = nil
}
```

Key: `guard !Task.isCancelled` after every `try? await Task.sleep` — the sleep's CancellationError is swallowed by `try?`, so the guard is the actual cancellation barrier.

### Fix 2: Two-step init with weak capture

```swift
// Before (retain cycle):
self.promptService = PromptService { action in
    coordinator?.webSocket?.send(action)  // captures self strongly
}

// After:
self.promptService = PromptService()
promptService.setSendHandler { [weak self] action in
    self?.webSocket?.send(action)
}
```

### Fix 3: Remove dead stepping state

```swift
// Before: dead currentQuestionIndex state
private struct QuestionCardContent: View {
    @State private var currentQuestionIndex = 0  // never advances
    // ...
}

// After: always show first question
private struct QuestionCardContent: View {
    var body: some View {
        if let question = questions.first {
            SingleQuestionView(question: question, ...)
        }
    }
}
```

### Fix 4: Enum parameter instead of String

```swift
// Before:
public func handleSessionStatus(_ status: String) {
    if status == "processing" { ... }
}

// After:
public func handleSessionStatus(_ status: SessionStatus) {
    if status == .processing { ... }
}
```

## Prevention

### Rules

1. **Task Rule**: Every `Task { }` must be stored in a property, cancelled before reassignment, and cancelled in deinit/dismiss
2. **Cancellation Rule**: After `try? await Task.sleep()`, always `guard !Task.isCancelled` before doing work
3. **Capture Rule**: Closures stored in `@Observable` class properties must use `[weak self]`
4. **Lifecycle Rule**: Don't assume SwiftUI views survive across service calls — if a service dismisses the prompt, the view is gone
5. **Type Rule**: Never use String comparisons for status/type values when an enum exists

### Code Review Checklist

- [ ] Every `Task { }` stored in a cancellable property?
- [ ] `guard !Task.isCancelled` after every `try? await` sleep/network call?
- [ ] Closures in `@Observable` init use `[weak self]`?
- [ ] Multi-step view state validated against service dismiss behavior?
- [ ] All status/type parameters use enums, not String?

### Pattern: Safe Task Loop

```swift
private var task: Task<Void, Never>?

func start() {
    task?.cancel()
    task = Task { @MainActor [weak self] in
        for item in items {
            guard !Task.isCancelled, let self else { return }
            self.process(item)
            try? await Task.sleep(for: .seconds(1))
        }
        guard !Task.isCancelled, let self else { return }
        self.finalize()
    }
}

func stop() {
    task?.cancel()
    task = nil
}
```

## Cross-References

- [SwiftUI Multi-Agent Review Findings: Phase 2](/docs/solutions/code-quality/swiftui-review-findings-consolidation.md) — Similar patterns found in Phase 2 (Task caching, scroll debounce)
- [Triaging Multi-Agent Review Findings](/docs/solutions/integration-issues/triaging-multi-agent-review-findings.md) — Review triage methodology, Swift 6 concurrency gotchas
- [Multi-select AppleScript Injection](/docs/solutions/integration-issues/multiselect-applescript-clipboard-race.md) — Server-side multi-select timing
- [swarm-fix skill](/.claude/skills/swarm-fix/SKILL.md) — Parallel fix workflow used to resolve all 12 findings
