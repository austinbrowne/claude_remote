---
module: iOS Voice I/O (SpeechService, AppCoordinator)
date: 2026-02-06
problem_type: runtime_error
component: service
symptoms:
  - "Mic button tap freezes the entire UI — app becomes unresponsive"
  - "App won't reopen after force-quit — stuck in crash loop"
  - "Audio interruption handler regression puts setActive back on MainActor"
root_cause: async_timing
resolution_type: code_fix
severity: critical
tags: [avaudio-session, setactive, mainactor, ui-freeze, crash-loop, task-detached, speech-service, audio-session, nonisolated-unsafe, deinit]
language: swift
framework: swiftui
related_solutions:
  - docs/solutions/concurrency-issues/voice-io-phase4-review-fixes.md
---

# Troubleshooting: AVAudioSession.setActive Blocks MainActor Causing UI Freeze and Crash-Loop

## Problem

Tapping the mic button in the iOS app freezes the UI. After force-quitting, the app enters a crash loop and won't reopen. Two distinct but related issues caused by `AVAudioSession.setActive(true)` being called synchronously on MainActor.

## Environment

- Module: iOS Voice I/O (SpeechService, AppCoordinator)
- Language/Framework: Swift 6 / SwiftUI
- Affected Component: SpeechService (audio session management), AppCoordinator (trigger restore)
- Date: 2026-02-06

## Symptoms

- Mic button tap freezes the entire UI — app becomes unresponsive
- App won't reopen after force-quit when trigger mode was enabled (crash loop)
- Audio interruption handler regression (commit 6a0db9a moved `setActive` from `Task.detached` to `Task { @MainActor }`)

## What Didn't Work

**Attempted: Fixing Swift 6 concurrency warnings by moving setActive onto MainActor (commit 6a0db9a)**
- **Why it failed:** This "fixed" Sendability warnings but introduced the actual freeze. `setActive(true)` is a blocking system call that can hang for seconds — running it on MainActor blocks the UI thread.

**Attempted: Using `MainActor.assumeIsolated` in deinit for property cleanup**
- **Why it failed:** `MainActor.assumeIsolated` traps at runtime if deinit runs off the main thread. While unlikely in practice, it's a time bomb for edge cases.

## Solution

### Fix 1: Move setActive off MainActor (scoped, no cascade)

Created a private async `activateAudioSession()` that runs `setActive` via `Task.detached`:

```swift
# Before (broken — blocks MainActor):
public func configureAudioSession(forBackground: Bool = false) throws {
    try session.setCategory(.playAndRecord, options: options)
    if !audioSessionConfigured {
        try session.setActive(true)  // BLOCKS UI
    }
}

# After (fixed — setActive runs off MainActor):
private func activateAudioSession(forBackground: Bool) async throws {
    try session.setCategory(.playAndRecord, options: options)
    if !audioSessionConfigured {
        try await Task.detached {
            try AVAudioSession.sharedInstance().setActive(true)
        }.value
    }
    audioSessionConfigured = true
}
```

Split `beginRecognition()` into two phases: async audio activation off MainActor, then synchronous engine setup on MainActor. Added `isStarting` guard to prevent double-tap during the async gap.

Fixed the interruption handler regression — moved `setActive(true)` back to `Task.detached`:

```swift
# Before (regression — on MainActor):
Task { @MainActor [weak self] in
    try? AVAudioSession.sharedInstance().setActive(true)  // BLOCKS UI
}

# After (fixed — off MainActor):
Task.detached { [weak self] in
    try? AVAudioSession.sharedInstance().setActive(true)
    await MainActor.run { /* resume trigger */ }
}
```

### Fix 2: Crash-loop timestamp guard

Added timestamp-based guard to `restoreTriggerIfNeeded()`:

```swift
let restoreKey = "triggerRestoreTimestamp"
let lastAttempt = UserDefaults.standard.double(forKey: restoreKey)
if lastAttempt > 0 && Date().timeIntervalSince1970 - lastAttempt < 10 {
    // Break crash loop — disable trigger, show toast
    state.triggerEnabled = false
    SettingsStore.saveTriggerEnabled(false)
    return
}
UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: restoreKey)
// ... restore logic ...
UserDefaults.standard.set(0.0, forKey: restoreKey)  // Clear on success
```

### Fix 3: Restore nonisolated(unsafe) on deinit properties

Restored `nonisolated(unsafe)` on 7 properties accessed in deinit. Removed `MainActor.assumeIsolated` wrapper. `Task.cancel()` and `NotificationCenter.removeObserver` are both thread-safe.

## Why This Works

1. **ROOT CAUSE:** `AVAudioSession.setActive(true)` is a blocking system call that can hang indefinitely when audio hardware isn't ready, another app holds the session, or after a crash/suspension. Running it on MainActor freezes the UI. When trigger mode auto-restores on launch, the hang triggers watchdog kill → crash → restore → hang → infinite loop.

2. **The solution addresses this by:**
   - Moving the blocking `setActive` call off MainActor via `Task.detached`, so it runs on a background thread
   - Adding crash-loop detection via timestamps so the app can break free if restore hangs
   - Using `nonisolated(unsafe)` instead of `MainActor.assumeIsolated` in deinit for defensive thread safety

3. **Key insight:** `setCategory` is fast and safe on MainActor — only `setActive` blocks. This allows a scoped fix without cascading async through the entire public API.

## Update (2026-02-08): audioEngine.start() Also Blocks

The original fix only moved `setActive` off MainActor. Freeze persisted because `audioEngine.start()`, `setCategory(.playAndRecord)`, `audioEngine.inputNode`, `installTap`, and `prepare` ALL can block MainActor. Fixed by wrapping the entire audio engine setup in `Task.detached` using `UnsafeSendable<T>` wrapper (see: `swift6-sendable-task-detached-wrapper-20260208.md`). Also made `configureAudioSession` non-blocking — it only registers observers now; actual `setCategory` + `setActive` deferred to async `activateAudioSession`.

## Prevention

- **Never run ANY CoreAudio operations on MainActor.** Not just `setActive` — `setCategory`, `audioEngine.start()`, `inputNode` access, `installTap`, and `prepare` can all block.
- **When fixing concurrency warnings, verify the fix doesn't move blocking calls onto MainActor.** The compiler warnings are about Sendability, not about whether the call blocks — these are orthogonal concerns.
- **Always add crash-loop protection when auto-restoring state on launch.** If the restore itself can fail, the app can get stuck in an infinite crash cycle.
- **Use `nonisolated(unsafe)` for deinit-accessed properties on @MainActor classes.** `MainActor.assumeIsolated` in deinit is a runtime trap waiting to happen.
- **Add `isStarting` guards when introducing async gaps in previously-synchronous flows.** The user can tap the button again during the gap.
- **The Xcode warning "'nonisolated(unsafe)' has no effect on @MainActor class property" is misleading.** The annotation IS needed for deinit access — suppress or ignore the warning.

## Related Issues

- See also: [Voice I/O Phase 4 review fixes](../concurrency-issues/voice-io-phase4-review-fixes.md)
