---
title: Voice I/O Phase 4 multi-agent review findings — concurrency, task management, and prompt matching fixes
date: 2026-01-30
category: concurrency-issues
tags: [speech-service, text-to-speech, speech-recognition, auto-mode, data-race, task-cancellation, prompt-matching, audio-session, notification-observer, checked-continuation, nslock]
module: iOS Voice I/O (SpeechService, AppCoordinator, VoicePromptMatcher)
severity: P1
symptoms:
  - SynthesizerDelegate data race on continuation access from arbitrary threads
  - handleVoiceResponse dead code — auto-mode never dispatched voice responses
  - Overlapping unstructured TTS tasks causing speech interruption
  - Prompt matching false positives ("not sure" matches "no", single-char "a" matches any option)
  - Audio interruption observer token discarded, handler never fires
  - 55-second recognition restart gap causing UI flicker and audio loss
  - Authorization fire-and-forget callback requiring user to tap mic twice
  - Duplicate audio session configuration in two methods
---

# Voice I/O Phase 4: Multi-Agent Review Fixes

After implementing Phase 4 Voice I/O (SpeechService with STT/TTS, voice prompt matching, auto-mode), a multi-agent code review found 12 findings across P1-P3 severity. After deduplication against future plan phases, 10 findings were fixed across 4 files.

## Root Cause

The initial implementation worked for the happy path but missed concurrency edge cases, lifecycle management, and false-positive-prone matching logic:

1. **Thread safety gap**: AVSpeechSynthesizerDelegate callbacks arrive on arbitrary threads, but the CheckedContinuation was accessed without synchronization.
2. **Incomplete dispatch loop**: Auto-mode spoke prompts (TTS output) but never wired the voice response back (STT input -> matching -> action). The `handleVoiceResponse` method existed but was never called.
3. **Unstructured concurrency**: Each prompt created a new untracked Task for TTS, causing overlapping speech.
4. **Overly loose matching**: `hasPrefix("no")` matched "not sure", "nobody", etc.
5. **Dropped observer token**: `NotificationCenter.addObserver`'s return value was discarded, making the observer eligible for immediate deallocation.
6. **Restart gap**: stop->start cycle flashed `isListening` false->true and dropped ~100-300ms of audio.

## Solution

### P1-1: NSLock for delegate thread safety

```swift
private final class SynthesizerDelegate: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?

    func resumeAndClear() {
        lock.lock()
        let c = continuation
        continuation = nil
        lock.unlock()
        c?.resume()
    }
}
```

**Pattern**: Any delegate bridge using CheckedContinuation must protect the continuation with a lock when the delegate callback thread differs from the actor that calls `stopSpeaking()`.

### P1-2: onTranscriptUpdate callback wiring

```swift
// SpeechService exposes callback
public var onTranscriptUpdate: ((String) -> Void)?

// AppCoordinator wires it before speakThenListen
speechService.onTranscriptUpdate = { [weak self] transcript in
    self?.handleVoiceResponse(transcript)
}
```

**Pattern**: When building a bidirectional loop (output -> TTS -> STT -> matching -> action), verify the full loop is connected end-to-end. Dead code analysis: if a public method has zero call sites, it's dead.

### P1-3: Tracked autoModeSpeechTask

```swift
private var autoModeSpeechTask: Task<Void, Never>?

// Cancel previous before creating new
autoModeSpeechTask?.cancel()
speechService.stopSpeaking()
autoModeSpeechTask = Task { @MainActor [weak self] in
    guard let self else { return }
    await speechService.speakThenListen(speech)
}
```

**Pattern**: Store a reference to any Task that may be superseded. Cancel the previous before creating a new one.

### P1-4: First-word exact matching

```swift
let words = cleaned.split(separator: " ").map(String.init)
guard let firstWord = words.first else { return .noMatch }
if ["deny", "no", "reject", "cancel"].contains(firstWord) { return .deny }
// "not sure" -> firstWord is "not" -> .noMatch
```

**Pattern**: Never use `hasPrefix` for keyword matching against free-form voice input. Split into words and match the first word exactly.

### P2-5: Stored observer token

```swift
private var interruptionObserver: (any NSObjectProtocol)?

interruptionObserver = NotificationCenter.default.addObserver(...)

deinit {
    if let observer = interruptionObserver {
        NotificationCenter.default.removeObserver(observer)
    }
}
```

**Pattern**: Always store the return value of `NotificationCenter.addObserver(forName:...)`. A discarded token means the observer is immediately eligible for deallocation.

### P2-7: Seamless restart via generation counter

```swift
private var recognitionGeneration = 0

private func restartRecognition() {
    recognitionGeneration += 1  // Invalidates stale callbacks
    teardownRecognition()       // Stops engine, removes tap — does NOT touch isListening
    beginRecognition()          // Immediately starts new session
}
```

**Pattern**: When restarting a resource with async callbacks, use a generation counter to invalidate stale callbacks from the old session. Separate teardown (engine cleanup) from state changes (isListening) so seamless restarts don't flash UI state.

### P3-10: Platform-neutral extraction

```swift
// VoicePromptMatcher.swift — no #if os(iOS), testable on macOS
public enum VoicePromptMatcher {
    public static func match(transcript: String, promptKind: PromptKind) -> VoicePromptMatch
}
```

**Pattern**: Extract pure logic out of platform-gated services so tests can run on all platforms without `#if os(iOS)`.

## Files Changed

| File | Change |
|------|--------|
| `Utilities/VoicePromptMatcher.swift` | New — platform-neutral matching logic |
| `Services/SpeechService.swift` | Rewritten — NSLock, generation counter, observer lifecycle, onTranscriptUpdate |
| `Services/AppCoordinator.swift` | Edited — autoModeSpeechTask, callback wiring, VoicePromptMatcher.match |
| `Tests/.../SpeechServiceTests.swift` | Rewritten — removed #if os(iOS), added false positive tests |

## Prevention

### Pre-Commit Checklist

- [ ] **CheckedContinuation + delegates**: Is the continuation accessed from multiple threads? Use NSLock.
- [ ] **Dispatch loop completeness**: Does every public handler method have at least one call site?
- [ ] **Task lifecycle**: Is every `Task { }` either awaited, stored for cancellation, or explicitly fire-and-forget with justification?
- [ ] **String matching**: Does any `hasPrefix`/`contains` operate on free-form user input? Use word-boundary matching.
- [ ] **Observer tokens**: Is every `NotificationCenter.addObserver` return value stored?
- [ ] **Duplicate configuration**: Is any setup (audio session, auth) called from exactly one code path?
- [ ] **Seamless restart**: Does any stop->start cycle flash observable state? Use teardown + begin without state change.
- [ ] **Authorization retry**: Does the auth callback actually retry the operation on success?
- [ ] **Boolean naming**: Do all boolean properties follow `is`/`has`/`should` prefix convention?
- [ ] **Platform gating**: Can pure logic be extracted from `#if os(...)` blocks for cross-platform testing?

### Key Test Cases

- False positive prevention: "not sure" -> `.noMatch`, "notice" -> `.noMatch`, "nobody" -> `.noMatch`
- Minimum transcript length: single char "a" -> `.noMatch` for question matching
- First-word exact: "yes please go ahead" -> `.allow` (multi-word with keyword at start)
- Empty/whitespace: "" -> `.noMatch`, "   " -> `.noMatch`

### Grep Patterns for Code Review

```bash
# Unprotected continuations
grep -rn 'var continuation.*CheckedContinuation' --include='*.swift'

# Fire-and-forget Tasks (no assignment)
grep -rn '^\s*Task\s*{' --include='*.swift' | grep -v '='

# hasPrefix on user input
grep -rn 'hasPrefix\|hasSuffix' --include='*.swift'

# Discarded observer tokens
grep -rn 'NotificationCenter.*addObserver' --include='*.swift' | grep -v '='

# Platform-gated test files
grep -rln '#if os(iOS)' Tests/
```

## Related Documentation

- [Swift Structured Concurrency Pitfalls](/docs/solutions/logic-errors/swift-structured-concurrency-pitfalls-observable-classes.md) — Phase 3 fire-and-forget Task patterns, weak captures
- [SwiftUI Review Findings Consolidation](/docs/solutions/code-quality/swiftui-review-findings-consolidation.md) — Task cancellation, nonisolated(unsafe)
- [Triaging Multi-Agent Review Findings](/docs/solutions/integration-issues/triaging-multi-agent-review-findings.md) — Swift 6 Sendable, actor isolation
- [Trigger Word Voice Activation Plan](/docs/plans/2026-01-30-feat-trigger-word-voice-activation-plan.md) — Phase 5 voice state machine, overlaps with audio session management
- [Phase 5 Trigger Word Audio Arbitration](trigger-word-phase5-audio-arbitration.md) — Phase 5 review: priority arbitration, state machine design, background audio, generation counters, platform-neutral extraction
