---
title: "Phase 6 SwiftUI View Identity & Performance Pitfalls"
date: 2026-01-31
category: code-quality
tags:
  - swiftui
  - view-identity
  - performance
  - computed-property
  - lazy-stack
  - ios
  - code-review
module: ClaudeRemote iOS (Phase 6 — Subagent + Task Tracking)
severity: critical
symptoms:
  - ForEach view thrashing and animation glitches from non-deterministic stableId
  - @State lost when TaskProgressView scrolled off-screen in LazyVStack
  - Subagent badge recomputing full filter+sort+map chain just for a count
  - Relative time labels frozen at initial value in SubagentListSheet
  - Sheet showing stale data captured at presentation time
  - Inconsistent ProgressView spinner sizes across views
  - Duplicate token formatting logic in SubagentRow and AppCoordinator
  - lastActivity field tracked but never displayed
root_cause:
  - UUID().uuidString used in computed property as ForEach identity fallback
  - Expensive collection pipeline in computed property when only count needed
  - @State placed inside LazyVStack child that gets deallocated on scroll
  - Sheet initialized with captured value instead of reading from @Environment
  - No timer mechanism to refresh time-dependent computed properties
  - Magic number styling constants not unified across views
  - Utility function duplicated rather than extracted to shared location
---

# Phase 6 SwiftUI View Identity & Performance Pitfalls

Eight review findings (1 critical, 3 important, 4 nice-to-have) discovered during multi-agent review of the Subagent Badge and Task Progress views.

## Related Docs

- [SwiftUI Multi-Agent Review Findings: Consolidation Pattern](./swiftui-review-findings-consolidation.md) — Phase 2/3 review findings
- [Phase 4 Voice I/O Prevention](./phase-4-voice-io-prevention.md) — prevention checklist for Voice/Audio code
- [Structured Concurrency Pitfalls](../logic-errors/swift-structured-concurrency-pitfalls-observable-classes.md) — Task lifecycle patterns
- [Triaging Multi-Agent Review Findings](../integration-issues/triaging-multi-agent-review-findings.md) — review triage methodology

## Fix 1 (P0 Critical) — stableId UUID Instability

`TaskItem.stableId` used `UUID().uuidString` as a fallback in a computed property. Since computed properties re-evaluate on every access, SwiftUI's ForEach saw a different identity each render cycle — causing view recreation, animation glitches, and @State loss.

```swift
// BEFORE (broken):
var stableId: String {
    id ?? (subject ?? UUID().uuidString)  // New UUID every access
}

// AFTER (fixed):
var stableId: String {
    id ?? subject ?? "task-unknown"  // Deterministic
}
```

**Rule:** Never use `UUID()`, `Date()`, or `Int.random()` in computed properties used as ForEach identities.

## Fix 2 (P1) — Expensive Computed Property for Count

`runningSubagents` performed filter+sort+map to build an array of tuples, but only `.count` was ever read.

```swift
// BEFORE:
private var runningSubagents: [(id: String, info: SubagentInfo)] {
    state.activeSubagents
        .filter { $0.value.status == "running" }
        .sorted { $0.value.startTime < $1.value.startTime }
        .map { (id: $0.key, info: $0.value) }
}
// Usage: Text("\(runningSubagents.count)")

// AFTER:
private var runningCount: Int {
    state.activeSubagents.values.filter { $0.status == "running" }.count
}
```

**Rule:** Match the computed property's return type to what the caller actually uses. Don't sort an array just to count it.

## Fix 3 (P1) — @State Lost in LazyVStack

`TaskProgressView` with `@State expandedTaskId` was a child of `LazyVStack`. When scrolled off-screen, LazyVStack deallocates the view and its @State. On reappear, a fresh instance is created with `expandedTaskId = nil`.

```swift
// BEFORE:
LazyVStack(spacing: 0) {
    TaskProgressView()           // Deallocated on scroll-away
    ForEach(state.messages) { ... }
}

// AFTER:
VStack(spacing: 0) {
    TaskProgressView()           // Persistent — non-lazy parent
    LazyVStack(spacing: 0) {
        ForEach(state.messages) { ... }
    }
}
```

**Rule:** Never place views with @State directly inside LazyVStack/LazyHStack. Use a non-lazy wrapper for pinned/header views, or hoist state to a parent.

## Fix 4 (P1) — Duplicate formatTokens

`SubagentRow.formatTokens()` duplicated `AppCoordinator.formatTokenUsage()`. Extracted to a shared function in `Extensions.swift`.

```swift
// Extensions.swift (shared):
public func formatTokenCount(_ input: Int, _ output: Int) -> String {
    let fmt = { (n: Int) -> String in
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return "\(n)"
    }
    return "\(fmt(input)) in / \(fmt(output)) out"
}
```

**Rule:** Extract on the second occurrence. If a formatting function appears in two files, move it to a shared utility.

## Fix 5 (P2) — Sheet Snapshot Not Reactive

`SubagentListSheet` received `let subagents: [String: SubagentInfo]` as an init parameter — a snapshot captured at sheet presentation time. Status changes while the sheet was open were invisible.

```swift
// BEFORE:
.sheet(isPresented: $showSheet) {
    SubagentListSheet(subagents: state.activeSubagents)  // Snapshot
}

// AFTER:
.sheet(isPresented: $showSheet) {
    SubagentListSheet()  // Reads @Environment(AppState.self) internally
}
```

**Rule:** Sheets should read from `@Environment` or `@Binding`, not captured values, when the underlying data can change while the sheet is open.

## Fix 6 (P2) — Inconsistent scaleEffect

`ProgressView` spinners used `scaleEffect(0.5)` in new Phase 6 views but `0.6` in existing MessageView and DiffView. Normalized all to `0.6`.

**Rule:** Audit magic numbers across the codebase when adding new views. Match existing values or extract to a named constant.

## Fix 7 (P2) — Relative Time Never Refreshes

`Date.relativeString` in SubagentRow was evaluated once during render. A 30-second tick timer in SubagentListSheet forces periodic re-evaluation via a `tick` parameter passed to each row.

```swift
// SubagentListSheet:
@State private var tick = 0

.task {
    while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(30))
        tick += 1
    }
}

// SubagentRow:
let _ = tick  // Creates dependency
Text(info.startTime.relativeString)  // Re-evaluated on tick change
```

**Rule:** Time-dependent labels need an explicit refresh mechanism. SwiftUI doesn't track wall-clock time as a dependency.

## Fix 8 (P2) — Unused lastActivity Field

`SubagentInfo.lastActivity` was updated by AppCoordinator on tool changes but never displayed. Added to SubagentRow footer when it differs from `startTime`.

```swift
if info.lastActivity > info.startTime {
    HStack(spacing: 4) {
        Image(systemName: "arrow.clockwise")
            .font(.caption2)
        Text(info.lastActivity.relativeString)
            .font(.caption2)
    }
    .foregroundStyle(.secondary)
}
```

**Rule:** If a model field is tracked and updated, display it or remove it. Unused data creates confusion about intent.

## Prevention Checklist

Use during code review of any SwiftUI view:

- [ ] ForEach identities are deterministic (no UUID/Date/random in computed properties)
- [ ] Computed properties in `var body` only compute what the caller uses (no sort for count)
- [ ] No `@State` inside LazyVStack/LazyHStack children (hoist to parent or use non-lazy wrapper)
- [ ] Formatting utilities appear in exactly one location (Extensions.swift)
- [ ] Sheets read live state via `@Environment`, not captured init parameters
- [ ] Magic numbers (scaleEffect, padding, cornerRadius) consistent across all views
- [ ] Time-dependent labels have a refresh timer (`.task` loop or `TimelineView`)
- [ ] All model fields are either displayed in UI or documented with a TODO comment

## Detection Commands

```bash
# Find non-deterministic ForEach identities
grep -rn "UUID().uuidString\|UUID()" Sources/ | grep -v "test\|Test"

# Find expensive computed properties in view bodies
grep -rn "\.filter.*\.sort\|\.sort.*\.map\|\.filter.*\.map" Sources/Views/

# Find @State inside lazy containers
grep -B5 "@State" Sources/Views/ | grep -A5 "LazyVStack\|LazyHStack"

# Find duplicate utility functions
grep -rn "func format" Sources/ | grep -v Tests

# Find time labels without refresh
grep -rn "relativeString" Sources/Views/ | grep -v "tick\|Timer\|TimelineView"
```

## Tests Added

8 new tests in `ExtensionsTests.swift`:
- `formatTokenCount`: small numbers, thousands, millions, zeros, exact boundary
- `TaskItem.stableId`: uses id, falls back to subject, falls back to deterministic static string
