# Fix: Mic Button Freeze + App Won't Reopen

**Status**: REVISED after 5-agent plan review

## Problem

When pressing the mic button in the iOS app, the UI freezes. After force-quitting, the app won't reopen (crash loop).

## Root Cause Analysis

Two distinct but related issues:

### Issue 1: UI Freeze on Mic Tap

The mic button calls `toggleListening()` -> `startListening()` -> `beginRecognition()` -> `ensureAudioSession()` -> `configureAudioSession()`, which calls **`AVAudioSession.sharedInstance().setActive(true)`** synchronously on the MainActor.

This is a **blocking system call** that can hang if:
- Audio hardware isn't ready
- Another app has the audio session
- The audio session was interrupted and not properly deactivated
- The app just came back from a crash/suspension

The codebase already has a comment acknowledging this at `ClaudeRemoteApp.swift:30`:
> "Calling setActive on MainActor at startup hangs the UI after crashes."

But this only protects the *launch* path. The mic button tap path still calls `setActive(true)` synchronously on MainActor via `configureAudioSession()`.

**Second call site**: Commit `6a0db9a` moved `setActive(true)` in `handleAudioInterruption` (line ~232) from `Task.detached` to `Task { @MainActor }`, putting it back on MainActor. This is the same blocking call on the same actor — a regression.

### Issue 2: App Won't Reopen (Crash Loop)

If trigger mode was enabled (`state.triggerEnabled = true`, persisted via `SettingsStore`), then on every app launch:

1. `ClaudeRemoteApp.init()` creates `AppCoordinator` which loads `SettingsStore` -> `triggerEnabled = true`
2. `scenePhase` transitions to `.active` -> `restoreTriggerIfNeeded()` is called
3. `restoreTriggerIfNeeded()` calls `configureAudioSession(forBackground: true)` -> `setActive(true)` **on MainActor**
4. If the audio session is in a bad state from the previous crash, this **hangs again** -> watchdog kills the app -> repeat

## Fixes (3 total — reviewed, revised)

### Fix 1: Move `setActive(true)` off MainActor (scoped approach)

**Key principle**: Keep all public API methods synchronous. Only the internal `setActive` call moves off MainActor.

**File**: `SpeechService.swift`

**Approach**: Make `configureAudioSession` private+async, called from a new internal async helper. Public methods stay synchronous and wrap in `Task {}`.

```swift
// PRIVATE async — only called internally
private func activateAudioSession(forBackground: Bool) async throws {
    let session = AVAudioSession.sharedInstance()
    var options: AVAudioSession.CategoryOptions = [.defaultToSpeaker, .allowBluetoothHFP]
    if forBackground { options.insert(.mixWithOthers) }
    try session.setCategory(.playAndRecord, options: options)

    if !audioSessionConfigured {
        // setActive can block — run off MainActor
        try await Task.detached {
            try AVAudioSession.sharedInstance().setActive(true)
        }.value
    }
    audioSessionConfigured = true
    registerAudioObservers() // extracted from configureAudioSession
}

// Keep public sync API — wraps async internally
public func configureAudioSession(forBackground: Bool = false) throws {
    // Sync path for setCategory (fast, safe on MainActor)
    let session = AVAudioSession.sharedInstance()
    var options: AVAudioSession.CategoryOptions = [.defaultToSpeaker, .allowBluetoothHFP]
    if forBackground { options.insert(.mixWithOthers) }
    try session.setCategory(.playAndRecord, options: options)
    registerAudioObservers()
    // NOTE: setActive is called separately via activateAudioSession
}
```

**Modified `beginRecognition`**: Split into two phases:

```swift
private func beginRecognition() {
    // Phase 1: Activate audio session off MainActor, then start recognition
    Task { @MainActor [weak self] in
        guard let self else { return }
        do {
            try await self.activateAudioSession(forBackground: self.isInTriggerMode)
            try self.startRecognitionEngine() // Phase 2: existing engine setup code
        } catch {
            if self.isInTriggerMode {
                self.scheduleRetry()
            } else {
                self.isListening = false
                self.onError?("Mic unavailable: \(error.localizedDescription)")
            }
        }
    }
}
```

**Fix the interruption handler regression** (line ~232): Move `setActive(true)` back to `Task.detached`:

```swift
case .ended:
    let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue ?? 0)
    if options.contains(.shouldResume) {
        Task.detached { [weak self] in
            try? AVAudioSession.sharedInstance().setActive(true)
            await MainActor.run {
                guard let self else { return }
                if self.triggerPaused {
                    self.triggerPaused = false
                    _ = try? self.startTriggerListening()
                }
            }
        }
    }
```

This restores the original `Task.detached` pattern that commit `6a0db9a` accidentally changed. The Sendability warning can be suppressed — `[weak self]` + `await MainActor.run` is the correct pattern here.

**What stays synchronous** (no cascade):
- `toggleListening()` — sync, calls `beginRecognition()` which now fires Task internally
- `startListening()` — sync
- `startTriggerListening()` — sync
- `InputBarView` mic button — unchanged
- `setTriggerEnabled()` — unchanged
- `restoreTriggerIfNeeded()` — unchanged

**Add `isStarting` guard** to prevent double-tap during async gap:

```swift
private var isStarting = false

public func startListening() throws {
    guard !isStarting else { return }
    // ... existing logic, beginRecognition sets isStarting = true
    // ... cleared when isListening becomes true or on error
}
```

**Error propagation**: Since `beginRecognition` now runs async internally, errors route through the existing `onError` callback rather than throwing. The InputBarView `do/catch` still works for synchronous errors (auth denied), while async errors (audio session failure) go through `onError` -> toast.

### Fix 2: Crash-loop protection with timestamp (self-healing)

**File**: `AppCoordinator.swift` — `restoreTriggerIfNeeded()`

Use a timestamp instead of a boolean. If the timestamp is recent (within 10 seconds), the previous restore likely crashed. If older, it's stale from a normal kill — ignore and proceed.

```swift
public func restoreTriggerIfNeeded() {
    guard state.triggerEnabled else { return }

    let restoreKey = "triggerRestoreTimestamp"
    let lastAttempt = UserDefaults.standard.double(forKey: restoreKey)

    // If we attempted restore within the last 10 seconds, we likely crashed during it
    if lastAttempt > 0 && Date().timeIntervalSince1970 - lastAttempt < 10 {
        print("[Trigger] Recent restore attempt (\(Int(Date().timeIntervalSince1970 - lastAttempt))s ago) — skipping to break crash loop")
        UserDefaults.standard.set(0.0, forKey: restoreKey)
        state.triggerEnabled = false
        SettingsStore.saveTriggerEnabled(false)
        state.showToast("Trigger word disabled after crash — re-enable in Settings", icon: "mic.slash", style: .warning)
        return
    }

    // Mark restore attempt start
    UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: restoreKey)

    // ... existing restore logic ...

    // Clear on success
    UserDefaults.standard.set(0.0, forKey: restoreKey)
}
```

**Self-healing**: If the app is killed for memory pressure (not a crash loop), the timestamp ages past 10 seconds and the guard auto-clears on next launch.

**Recovery path**: User re-enables trigger in Settings via `setTriggerEnabled(true)`, which bypasses this guard (different code path). The toast tells them what to do.

### Fix 3: Restore `nonisolated(unsafe)` on deinit-accessed properties

**File**: `SpeechService.swift`

Restore `nonisolated(unsafe)` on these 7 properties accessed in `deinit`:

1. `restartTask: Task<Void, Never>?`
2. `interruptionObserver: (any NSObjectProtocol)?`
3. `mediaResetObserver: (any NSObjectProtocol)?`
4. `routeChangeObserver: (any NSObjectProtocol)?`
5. `retryTask: Task<Void, Never>?`
6. `silenceTask: Task<Void, Never>?`
7. `cooldownTask: Task<Void, Never>?`

Remove the `MainActor.assumeIsolated` wrapper from `deinit` — go back to direct access.

**Rationale**: `MainActor.assumeIsolated` traps at runtime if `deinit` runs off the main thread. While unlikely in practice (SwiftUI `@State` releases on MainActor), `nonisolated(unsafe)` is the defensive choice. `Task.cancel()` and `NotificationCenter.removeObserver` are both thread-safe operations, so the cleanup is safe from any thread.

**Expected Xcode warnings**: 7 warnings "`nonisolated(unsafe)` has no effect on a @MainActor class property". These are **acceptable** — the annotation is needed for `deinit` access, not for the class's normal isolation.

Add a comment block above the properties:

```swift
// These properties are nonisolated(unsafe) because they are accessed in deinit,
// which is nonisolated. Task.cancel() and NotificationCenter.removeObserver are
// both thread-safe, so cleanup is safe from any thread. The Xcode warning
// "'nonisolated(unsafe)' has no effect" is expected and acceptable.
```

## Implementation Order

1. **Fix 3** (deinit) — Restore `nonisolated(unsafe)`, remove `MainActor.assumeIsolated`. Low risk, independent.
2. **Fix 2** (crash-loop protection) — Add timestamp guard to `restoreTriggerIfNeeded()`. Independent.
3. **Fix 1** (scoped async `setActive`) — Split `beginRecognition`, add `isStarting` guard, fix interruption handler regression. Highest impact.

## Verification

**Automated**:
- `cd ClaudeRemote && swift build && swift test` — all 406 tests pass
- Xcode build — only the 7 expected `nonisolated(unsafe)` warnings, no errors

**Manual (device)**:
- Tap mic button — should not freeze UI, recognition starts after brief async gap
- Double-tap mic button quickly — should not crash or start two sessions
- Enable trigger mode, force-quit, reopen — should not crash-loop
- Force-quit during trigger mode, reopen — should show "disabled after crash" toast
- Re-enable trigger in Settings after crash guard — should work
- Audio interruption (phone call) during trigger mode — should pause and resume
- All speech recognition still works (manual + trigger + auto modes)

## Review Notes

**Dropped from original plan**:
- ~~Fix 4 (revert recognitionTask callback to DispatchQueue.main.async)~~ — Dropped per review. No profiling data shows performance issues. `@MainActor` serial executor provides FIFO ordering for same-priority Tasks. Mixing GCD and Swift concurrency in the same class is a maintenance hazard.

**Investigated but not pursued**:
- `audioEngine.start()` may also block on MainActor. If freeze persists after Fix 1, this should be profiled and potentially moved off MainActor too.
