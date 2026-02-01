---
title: "Phase 4 Voice I/O: Prevention Checklist & Testing Guidance"
date: 2026-01-30
category: code-quality
tags: [swift, ios, voice-io, audio, concurrency, testing, prevention]
module: ClaudeRemote iOS
severity: high
---

## Prevention

### Pre-Commit Checklist for Voice/Audio Code

- [ ] **Data races on continuations**: If using `CheckedContinuation`, verify it's protected by `NSLock` or accessed only from `@MainActor`. Mark delegate classes `@unchecked Sendable` with explicit lock documentation.
- [ ] **Dead code hunt**: Search for functions defined but never called. Check both direct callers and potential indirect dispatch paths (delegates, callbacks, async tasks).
- [ ] **Structured Task creation**: No fire-and-forget Tasks without cancellation token storage. Tasks that may overlap must be cancelled before new ones start (use `task?.cancel()` before reassignment).
- [ ] **String prefix/contains false positives**: Prefer exact enum matching over `hasPrefix`. If using substring matching, test both "word " and "word," and emoji variants (e.g., "🎙️").
- [ ] **NotificationCenter observer lifetimes**: Never discard the opaque token returned by `addObserver`. Store it as an instance property and remove in `deinit`. Leak = observer fires forever.
- [ ] **Config duplication**: Voice initialization (audio session, sample rates, formats) must occur once. Search for repeated `setCategory`, `setActive`, `recognitionRequest` setup across files.
- [ ] **State flashing on restart**: Avoid `stop()` then `start()` separated by state reset. Use seamless restart: teardown recognition only, keep UI state live, call `beginRecognition()` immediately.
- [ ] **Authorization without retry**: Speech/Microphone auth callbacks must retry initialization if granted. Don't silently return; emit callback that triggers `startListening()` again.
- [ ] **Naming consistency**: Pick one pattern: `isListening/isSpeaking` (boolean) or `autoMode/triggerMode` (mode name). Don't mix. Enforce in type definitions.
- [ ] **Platform-gated logic**: Code in `#if os(iOS)` blocks prevents cross-platform testing. Provide mock implementations in test target or extract iOS-specific details into protocols.

### Test Cases (Always Include)

1. **Concurrency safety**: Start recognition → immediately call `stopListening()` → verify no race in delegate resumption or continuation access
2. **Observer cleanup**: Init → `configureAudioSession()` → deinit → verify `NotificationCenter` observer fires 0 times (dealloc removed it)
3. **Authorization retry**: Auth `.notDetermined` → call `startListening()` → grant in system dialog → verify `beginRecognition()` fires (not just return)
4. **Seamless restart**: 55s timeout → `restartRecognition()` → verify `isListening` stays `true` (no UI flicker)
5. **Prefix matching edge cases**: Trigger "titus" → test "Titus ", "titus,", "titus!", "tightest" (variant) — all should match, then strip and capture suffix
6. **Task cancellation overlap**: Auto-mode active → new prompt arrives → verify old `autoModeSpeechTask` cancelled, new one starts (not both speaking)
7. **Dead code verification**: Run unused code detection tool; verify `speakThenListen`, delegate methods, recognition callbacks all reachable from entry points
8. **Config uniqueness**: Grep for `setCategory`, `setActive`, `playAndRecord` — should appear exactly once per service lifecycle
9. **Empty transcript handling**: Silence → transcript="" → verify `onTranscriptUpdate` not called (empty guard on line 169)
10. **Platform mock testing**: Extract `SynthesizerDelegate` protocol or move AVFoundation calls behind an audio adapter interface to allow testing without iOS runtime

### Grep Patterns for Code Review

```bash
# Find unprotected continuations (should have NSLock or @MainActor context)
grep -n "CheckedContinuation" Sources/ClaudeRemote/Services/*.swift | grep -v "lock\|NSLock\|@MainActor"

# Find dead function definitions (defined but never called)
grep -rn "private func\|func" Sources/ | awk '{print $NF}' | sort | uniq -d

# Find fire-and-forget Tasks without cancellation storage
grep -n "Task {" Sources/ | grep -v "restartTask\|autoModeTask\|speechTask"

# Find string prefix checks (potential false positives)
grep -rn "hasPrefix\|contains" Sources/ClaudeRemote/Services/*.swift

# Find orphaned NotificationCenter observers (token not stored)
grep -B2 "addObserver" Sources/ | grep -v "let.*Observer\|var.*observer"

# Find multiple audio session configurations
grep -n "setCategory\|setActive\|playAndRecord" Sources/ClaudeRemote/Services/*.swift

# Find state resets adjacent to start/stop (may cause flicker)
grep -B1 -A1 "stopListening\|startListening" Sources/ | grep -E "= false|= true"

# Find auth callbacks without retry
grep -A5 "requestAuthorization" Sources/ | grep -v "startListening\|tryAgain"

# Find inconsistent state variable naming
grep -n "isListening\|isSpeaking\|autoMode\|triggerMode" Sources/ClaudeRemote/**/*.swift | cut -d: -f1 | sort | uniq -c

# Find platform-gated code without mock
grep -n "#if os(iOS)" Sources/ | xargs -I {} grep -A10 {} | grep -v "public.*protocol\|= .*Mock"
```
