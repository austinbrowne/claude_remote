---
module: iOS Voice I/O (SpeechService)
date: 2026-02-08
problem_type: build_error
component: service
symptoms:
  - "Passing closure as a 'sending' parameter risks causing data races between main actor-isolated..."
  - "Builds with SPM (swift build) but fails in Xcode"
  - "nonisolated(unsafe) on property doesn't silence the error"
root_cause: type_error
resolution_type: code_fix
severity: medium
tags: [swift6, sendable, task-detached, unchecked-sendable, avaudoengine, mainactor, data-races, concurrency]
language: swift
framework: swiftui
related_solutions:
  - docs/solutions/runtime-errors/setactive-mainactor-freeze-crash-loop-20260206.md
---

# Swift 6: @unchecked Sendable Wrapper for Task.detached with Non-Sendable Types

## Problem

Moving `AVAudioEngine` operations into `Task.detached` to avoid MainActor UI freeze causes a Swift 6 build error: "Passing closure as a 'sending' parameter risks causing data races between main actor-isolated..." Xcode enforces this more strictly than SPM — code builds with `swift build` but fails in Xcode.

## Environment

- Swift 6.0, Xcode
- `@MainActor @Observable` class with non-Sendable properties

## Symptoms

- Build error in Xcode: "Passing closure as a 'sending' parameter risks causing data races"
- `swift build` succeeds (SPM uses different concurrency checking defaults)
- `nonisolated(unsafe)` on the property does NOT fix it — the local variable capturing it is still MainActor-isolated

## What Didn't Work

**`nonisolated(unsafe) private let audioEngine = AVAudioEngine()`**
This removes the isolation on the *property*, but when you write `let engine = audioEngine` inside a `@MainActor` method, the local `engine` binding is still considered MainActor-isolated. Passing it into `Task.detached` closure still fails.

## Solution

Use an `@unchecked Sendable` wrapper struct:

```swift
/// Wrapper to send non-Sendable values across isolation boundaries
/// when we guarantee serial access.
private struct UnsafeSendable<T>: @unchecked Sendable {
    let value: T
}

// Usage:
let engine = UnsafeSendable(value: audioEngine)
let req = UnsafeSendable(value: request)
try await Task.detached {
    let inputNode = engine.value.inputNode
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
        req.value.append(buffer)
    }
    engine.value.prepare()
    try engine.value.start()
}.value
```

## Why This Works

`@unchecked Sendable` tells the compiler "I guarantee this is safe to send across isolation boundaries." The guarantee holds because:
1. Only one recognition session runs at a time (`isStarting` guard + `recognitionGeneration` counter)
2. The detached task runs serially — no concurrent access to the engine
3. `teardownRecognition()` is always called before a new session starts

## Prevention

- **When moving @MainActor work to Task.detached, always wrap non-Sendable captures in `@unchecked Sendable`.** `nonisolated(unsafe)` on the property is not enough.
- **Test with Xcode, not just SPM.** Xcode's Swift 6 concurrency checking is stricter than SPM's defaults.
- **Document WHY the unchecked Sendable is safe** — what serialization guarantee prevents data races.
- **This is a well-known Swift concurrency pattern.** Apple's own WWDC sessions demonstrate this approach for crossing isolation boundaries with non-Sendable types.
