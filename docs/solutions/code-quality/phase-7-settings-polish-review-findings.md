---
title: "Phase 7 Settings & Polish — Review Findings and P1 Fixes"
date: 2026-01-31
category: code-quality
tags:
  - swift-concurrency
  - task-cancellation
  - authentication
  - settings-persistence
  - toast-notifications
  - haptic-feedback
  - speech-service
  - code-review
  - ios
module: ClaudeRemote iOS (Phase 7 — Settings + Polish)
severity: critical
symptoms:
  - Ghost speech listener persists after prompt dismissed or session switched
  - App shows authenticated state before server confirms token
  - Voice command injected into wrong session after session switch
  - speakThenListen starts recognition after Task already cancelled
  - Internal type ToastItem used in public @Observable property (compile error)
  - UserDefaults.standard access from non-@MainActor context (Swift 6 error)
  - MessageType.system referenced but doesn't exist in enum
root_cause:
  - No Task.isCancelled check after await in speakThenListen()
  - Auto-mode speech task not cancelled when prompt dismissed by status change
  - isAuthenticated set in AuthView before authResult received from server
  - cancelAutoModeSpeech() not called in watchSession() before switching
  - ToastItem and ToastStyle not marked public + Sendable for @Observable use
  - SettingsStore enum missing @MainActor annotation for UserDefaults access
  - Debug message used non-existent .system MessageType instead of .statusUpdate
---

# Phase 7 Settings & Polish — Review Findings and P1 Fixes

Phase 7 added SettingsView, persistent configuration (UserDefaults + Keychain), toast notifications, haptic feedback, debug mode, and swipe session switching. A six-agent code review surfaced 4 P1 (critical), 6 P2 (high), and 11 P3 (medium) findings. The P1 issues were fixed before commit.

## Related Docs

- [Phase 6 SwiftUI View Identity Pitfalls](./phase-6-swiftui-view-identity-pitfalls.md) — Prior phase review findings
- [SwiftUI Review Findings Consolidation](./swiftui-review-findings-consolidation.md) — Phase 2/3 patterns
- [Voice I/O Phase 4 Review Fixes](../concurrency-issues/voice-io-phase4-review-fixes.md) — Speech service concurrency
- [Trigger Word Phase 5 Audio Arbitration](../concurrency-issues/trigger-word-phase5-audio-arbitration.md) — Trigger mode lifecycle
- [Structured Concurrency Pitfalls](../logic-errors/swift-structured-concurrency-pitfalls-observable-classes.md) — General Swift concurrency patterns
- [Triaging Multi-Agent Review Findings](../integration-issues/triaging-multi-agent-review-findings.md) — Review process

## Phase 7 Scope

### Files Created (4)

| File | Lines | Purpose |
|------|-------|---------|
| `Views/SettingsView.swift` | 203 | Form-based settings UI with 6 sections |
| `Utilities/SettingsStore.swift` | 75 | `@MainActor` enum for UserDefaults persistence |
| `Views/Components/ToastView.swift` | 67 | ToastItem model + ToastOverlay with auto-dismiss |
| `Utilities/HapticService.swift` | 36 | Static haptic feedback (6 types, iOS only) |

### Files Modified (5)

| File | Changes |
|------|---------|
| `Models/AppState.swift` | Added `currentToast`, `showToast()` |
| `Services/AppCoordinator.swift` | Settings load, reconnect, syncSettings, toast/haptic/debug integration, `cancelAutoModeSpeech()`, P1 fixes |
| `Views/AuthView.swift` | Keychain token storage, coordinator connection, removed premature `isAuthenticated`, added `onChange` for disconnect |
| `Views/ContentView.swift` | Settings sheet, toast overlay, disconnected banner, swipe session switching |
| `Services/SpeechService.swift` | Added `Task.isCancelled` guard in `speakThenListen()` |

### Tests Created/Modified (3 files, 26 tests)

| File | Tests | Coverage |
|------|-------|----------|
| `SettingsStoreTests.swift` (new) | 12 | Save/load round-trips for all 8 setting keys |
| `ToastViewTests.swift` (new) | 7 | ToastItem init, equality, uniqueIds, style cases; AppState showToast, replace, default style |
| `AppCoordinatorTests.swift` (modified) | +6 | Debug mode on/off, connect/disconnect toast, auth failure toast, auth success sets isAuthenticated |

---

## P1 Critical Fixes

### P1-1: Missing Task.isCancelled After Await in speakThenListen()

**File:** `Services/SpeechService.swift:535-538`

**Root cause:** `speakThenListen()` uses `await withCheckedContinuation` to wait for TTS to finish, then immediately calls `startListening()`. If the parent Task was cancelled during TTS (session switch, prompt dismissed, new prompt arrived), `try? await` swallows the `CancellationError` and recognition starts on a stale prompt.

**Before:**
```swift
public func speakThenListen(_ text: String) async {
    // ... TTS setup and await ...
    isSpeaking = false
    self.synthesizerDelegate = nil
    try? startListening()  // Runs even if Task was cancelled
}
```

**After:**
```swift
public func speakThenListen(_ text: String) async {
    // ... TTS setup and await ...
    isSpeaking = false
    self.synthesizerDelegate = nil
    guard !Task.isCancelled else {
        resumeTriggerIfPaused()
        return
    }
    try? startListening()
}
```

**Why it works:** `Task.isCancelled` is a cooperative check — if `autoModeSpeechTask?.cancel()` was called while TTS was playing, the guard fires after the continuation resumes. Trigger listening resumes via `resumeTriggerIfPaused()` so background wake-word detection isn't permanently stopped.

**Without the fix:** Ghost recognition session starts, consuming microphone and CPU. If auto-mode transcript callback is still wired, voice input could match against a nil or wrong prompt.

### P1-2: Ghost Listener When Prompt Dismissed During Recognition

**File:** `Services/AppCoordinator.swift:207-208, 213-214, 375-382`

**Root cause:** When session status changes to "active" or "processing" (meaning Claude finished), `promptService.handleSessionStatus()` clears `currentPrompt`. But the `autoModeSpeechTask` was only cancelled when a *new* prompt arrived, not when the current one was dismissed. The speech service kept listening with the `onTranscriptUpdate` callback still wired to `handleVoiceResponse()`.

**Fix:** Added `cancelAutoModeSpeech()` helper called in `.sessionStatus` and `.statusUpdate` handlers when prompt becomes nil:

```swift
private func cancelAutoModeSpeech() {
    autoModeSpeechTask?.cancel()
    autoModeSpeechTask = nil
    speechService.onTranscriptUpdate = nil
    if speechService.isListening { speechService.stopListening() }
    if speechService.isSpeaking { speechService.stopSpeaking() }
}
```

Called in status handlers:
```swift
case .sessionStatus(_, let status, _):
    state.sessionStatus = SessionStatus(rawValue: status) ?? .unknown
    promptService.handleSessionStatus(...)
    #if os(iOS)
    if promptService.currentPrompt == nil { cancelAutoModeSpeech() }
    #endif
```

**Without the fix:** Recognition continues consuming microphone. If user speaks, `handleVoiceResponse()` fires against nil `promptService.currentPrompt` and silently returns (no crash, but wasted resources and confusing behavior if trigger mode tries to start).

### P1-3: Premature isAuthenticated Before Server Confirms

**File:** `Views/AuthView.swift:133-134`, `Services/AppCoordinator.swift:148-149`

**Root cause:** `AuthView.connectAction()` set `state.isAuthenticated = true` immediately after calling `coordinator.connect()`, before the server sent `authResult(success: true)`. If the server rejected the token, the app briefly showed the main view (gated on `isAuthenticated`) before snapping back to auth.

**Before (AuthView):**
```swift
coordinator.connect(url: wsURL, token: token)
state.isAuthenticated = true  // Premature — server hasn't confirmed
isConnecting = false
```

**After (AuthView):**
```swift
coordinator.connect(url: wsURL, token: token)
// isAuthenticated is set by AppCoordinator when authResult(success: true) arrives
```

**After (AppCoordinator):**
```swift
case .authResult(let success, let error):
    if success {
        state.isAuthenticated = true  // Server confirmed
    } else {
        state.isAuthenticated = false
        state.isConnected = false
        // ... error toast ...
    }
```

AuthView also gained an `onChange` observer to reset `isConnecting` when the connection drops:
```swift
.onChange(of: state.isConnected) { _, isConnected in
    if !isConnected { isConnecting = false }
}
```

**Without the fix:** Race condition where UI flashes to main view then back to auth. On slow networks, the user sees the main app with no sessions for a visible moment before auth failure kicks them back.

### P1-4: Session Switch During Auto-Mode Injects Into Wrong Session

**File:** `Services/AppCoordinator.swift:73-75`

**Root cause:** `watchSession()` switches the active session and updates `promptService.sessionId`. But if auto-mode was listening for a voice response to a prompt from the *previous* session, `handleVoiceResponse()` would dispatch the response using the now-updated session context. The voice command could be injected into the wrong session.

**Before:**
```swift
public func watchSession(_ sessionId: String) {
    webSocket?.setLastWatchedSession(sessionId)
    webSocket?.send(.watchSession(sessionId: sessionId))
    promptService.sessionId = sessionId
}
```

**After:**
```swift
public func watchSession(_ sessionId: String) {
    #if os(iOS)
    cancelAutoModeSpeech()
    #endif
    webSocket?.setLastWatchedSession(sessionId)
    webSocket?.send(.watchSession(sessionId: sessionId))
    promptService.sessionId = sessionId
}
```

**Without the fix:** User says "allow" in response to a permission prompt from Session A. Before the voice match completes, they swipe to Session B. The permission response gets sent to Session B's context, potentially granting a permission the user didn't intend.

---

## Swift 6 Concurrency Fixes (Build Errors)

### ToastItem Access Control

**Symptom:** `ToastItem` was internal but used in public `AppState.currentToast` property. Swift 6 strict concurrency also requires `Sendable` conformance for types in `@Observable` properties.

**Fix:** Made `ToastItem`, `ToastStyle` public and `Sendable`. Made `==` operator public.

### SettingsStore @MainActor

**Symptom:** `UserDefaults.standard` accessed from non-`@MainActor` context in `SettingsStore` static methods. Swift 6 flags this as a concurrency violation.

**Fix:** Annotated the entire `SettingsStore` enum with `@MainActor`. Since all callers (AppCoordinator init, SettingsView onChange, AuthView) already run on `@MainActor`, this is zero-cost.

### Debug Message Type

**Symptom:** Debug mode used `MessageType.system` which doesn't exist in the enum. Build error.

**Fix:** Changed to `.statusUpdate`, which exists and is semantically appropriate for debug output in the chat stream.

---

## P2/P3 Findings (Deferred)

These were identified by the review but deferred to follow-up work:

### P2 (High)
1. Syntax highlighting runs on main thread (`SyntaxHighlighting.swift`)
2. LCS diff runs synchronously on main thread (`DiffView.swift`)
3. `messages.removeFirst()` is O(n) at 500-message cap (`AppState.swift`)
4. Reconnect creates unbounded fire-and-forget Tasks (`WebSocketService.swift`)
5. `nonisolated(unsafe)` Highlightr is a latent data race (`SyntaxHighlighting.swift`)
6. Voice auto-mode false positives from partial transcript matches

### P3 (Medium)
1. Toast auto-dismiss race when toasts overlap rapidly
2. Silence timer not cancelled on trigger restart
3. ~80 lines dead code (`speak()` in SpeechService, unused SubagentInfo fields)
4. AppCoordinator trending toward God Object (450+ lines)
5. HistoryEntry and ClaudeOutputData are near-duplicate types
6. `watchSession` sends to server even if already watching that session
7. `send()` in WebSocketService creates unordered fire-and-forget Tasks
8. No retry/backoff on reconnect failures
9. `formatTokenCount` duplicated between AppCoordinator and SubagentRow
10. Missing `#if os(iOS)` guard on one HapticService call site
11. SettingsView voice picker loads all voices on every render

---

## Prevention Principles

### 1. Always Check Task.isCancelled After try? await

`try?` suppresses `CancellationError`. The `guard !Task.isCancelled` after the await is the real cancellation barrier. Every `try? await` in a stored Task needs this check.

```swift
// BAD
try? await Task.sleep(for: .seconds(1))
doSomething()  // Runs even if cancelled

// GOOD
try? await Task.sleep(for: .seconds(1))
guard !Task.isCancelled else { return }
doSomething()
```

### 2. Cancel Resources Before State Transitions

Any long-lived resource (listener, recognizer, Task) must be cancelled *before* the parent state changes. Don't rely on the resource noticing the change.

```swift
// BAD: state changes, resource doesn't notice
promptService.sessionId = newSessionId  // Old listener still running

// GOOD: cancel first, then change state
cancelAutoModeSpeech()
promptService.sessionId = newSessionId
```

### 3. Server-Verified Facts Only

Authentication, authorization, and session state should only be set when the server explicitly confirms. Local intent ("I tried to connect") is not the same as server fact ("auth succeeded").

### 4. Public @Observable Properties Need Public + Sendable Types

Swift 6 strict concurrency enforces this at compile time. Any custom type used in a `public` property of an `@Observable` class must be `public` and `Sendable`.

### 5. @MainActor for UserDefaults Access

Wrap all `UserDefaults.standard` access in `@MainActor` methods. Since `AppState` and most callers are already `@MainActor`, this is free and prevents concurrency violations.

---

## Code Review Checklist (Phase 7+)

- [ ] Every `try? await` in a stored Task followed by `guard !Task.isCancelled`?
- [ ] `cancelAutoModeSpeech()` called before session/prompt state transitions?
- [ ] `isAuthenticated` only set in `authResult` handler, never in views?
- [ ] All types in public `@Observable` properties are public + Sendable?
- [ ] UserDefaults access wrapped in `@MainActor` methods?
- [ ] Toast/haptic calls guarded by `#if os(iOS)` where needed?
- [ ] Settings save methods called in `onChange` handlers (not computed properties)?
- [ ] Keychain used for secrets, UserDefaults for preferences only?
