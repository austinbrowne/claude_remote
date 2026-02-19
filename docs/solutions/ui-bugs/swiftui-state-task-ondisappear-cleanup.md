---
title: "SwiftUI @State Task must be cancelled in .onDisappear"
category: ui-bugs
tags: [swift, swiftui, task, debounce, lifecycle]
severity: medium
date: 2026-02-18
---

# SwiftUI @State Task Cleanup on .onDisappear

## Problem

When using `@State private var debounceTask: Task<Void, Never>?` with `Task.sleep` for debounce, the task can fire after the view is dismissed. The `@MainActor` closure sets `@State` on a discarded view, which may produce ghost side effects (e.g., injecting a command into a session the user has left).

## Root Cause

`.onChange` handlers cancel the task when conditions change, but if the view disappears entirely (navigation pop, modal dismiss, tab switch), `.onChange` is NOT called — only `.onDisappear` fires.

## Fix

Always pair `.onAppear` with `.onDisappear` for Task cleanup:

```swift
@State private var debounceTask: Task<Void, Never>?

var body: some View {
    content
        .onAppear { startDebounce() }
        .onDisappear { debounceTask?.cancel(); debounceTask = nil }
        .onChange(of: someCondition) { _, _ in startDebounce() }
}
```

## Gotchas

1. **`.onChange` is not enough** — it only fires when the observed value changes while the view is alive.
2. **MainActor serialization makes this safe from crashes** — but the side effects (network calls, state mutations) still execute on the wrong context.
3. **The Task's `guard !Task.isCancelled` check is the last defense** — but there's a TOCTOU window between the guard and the actual work.

## Files

- `ClaudeRemote/Sources/ClaudeRemote/Views/InputBarView.swift` — `fallbackDebounceTask` cleanup
