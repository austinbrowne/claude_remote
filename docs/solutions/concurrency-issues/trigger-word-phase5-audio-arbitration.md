---
title: "Phase 5 trigger word mode: audio priority arbitration and state machine design"
date: 2026-01-30
category: concurrency-issues
tags: [swift, swiftui, ios, audio, speech-recognition, state-machine, priority-arbitration, background-audio, wake-word, trigger-word, concurrency]
module: ClaudeRemote iOS
severity: high
symptoms:
  - Multiple audio consumers (trigger, manual mic, TTS) competing for single AVAudioEngine
  - SFSpeechRecognizer 60-second hard limit requires seamless restart without losing captured commands
  - State consistency under async callbacks from recognition task and silence timer
  - Background audio dying after screen lock without UIBackgroundModes
  - Stale recognition callbacks overwriting state from newer sessions
root_cause: Always-on wake word detection must coexist with manual mic, TTS playback, and auto-mode prompt response on a single shared AVAudioEngine and SFSpeechRecognizer, requiring explicit priority arbitration, state preservation across recognition restarts, and generation-based stale callback rejection
resolution: Four-state trigger machine (IDLE/LISTENING/CAPTURING/COOLDOWN) with triggerPaused flag for cooperative yielding, generation counter for stale callbacks, platform-neutral TriggerWordDetector extraction for testability, background audio via UIBackgroundModes + .mixWithOthers
---

# Phase 5: Trigger Word Mode — Audio Priority Arbitration

## Problem Statement

Building always-on "Titus" wake word detection for an iOS Claude Code remote monitoring app. The challenge: four audio consumers (trigger listening, manual mic, TTS playback, auto-mode prompt response) share one `AVAudioEngine` and one `SFSpeechRecognizer`. iOS allows only one recognition task at a time, and Apple imposes a 60-second hard limit on each task. The trigger must survive screen lock, app backgrounding, phone call interruptions, and rapid mode switches — without losing captured commands or corrupting state.

## Design Decisions

### On-device recognition for trigger mode

Trigger mode sets `request.requiresOnDeviceRecognition = true`. The rationale: trigger mode is always-on, potentially running for hours. Network-based recognition would drain battery, consume bandwidth, and fail offline. Manual mic mode uses server-based recognition (higher quality, short-lived).

```swift
// SpeechService.swift:268-270
if isInTriggerMode {
    request.requiresOnDeviceRecognition = true
}
```

### Platform-neutral TriggerWordDetector extraction

`TriggerWordDetector` is a pure `enum` with static methods — zero hardware dependencies, no `#if os(iOS)`. SpeechService is gated behind `#if os(iOS)` and can't run tests on macOS. By extracting trigger matching logic to a separate file importing only `Foundation`, all 31 detection tests run on the macOS test runner.

### Priority arbitration via cooperative yielding

Rather than a queue or semaphore, the implementation uses a simple `triggerPaused` boolean flag. Higher-priority consumers call `pauseTriggerForTTS()` before acquiring audio and `resumeTriggerIfPaused()` after releasing it. This avoids deadlocks and keeps the model simple.

### State preservation across 55-second restarts

`restartTriggerRecognition()` tears down the audio engine and recognition task but deliberately preserves `capturedCommand`, `triggerState`, and `lastTranscriptLength`. The user's in-progress command survives the restart boundary seamlessly.

## Root Cause

Four audio modes compete for one shared `AVAudioEngine`:

| Priority | Mode | Behavior |
|----------|------|----------|
| 1 (highest) | Auto-mode prompt response | TTS speaks prompt, then listens for voice match |
| 2 | Manual mic | User taps button, transcript fills text field |
| 3 | TTS playback | Synthesizer reads text aloud |
| 4 (lowest) | Trigger listening | Always-on wake word detection |

Without explicit arbitration, starting manual mic while trigger is active crashes (two recognition tasks). Without state preservation, the 55-second restart drops captured commands. Without generation counters, stale callbacks from old sessions corrupt state.

## Working Solution

### 1. TriggerState State Machine

```swift
// SpeechService.swift:7-12
public enum TriggerState: Sendable, Equatable {
    case idle        // Not listening
    case listening   // Waiting for "Titus"
    case capturing   // Trigger detected, accumulating command
    case cooldown    // Command sent, brief pause before re-listen
}
```

Transitions:
```
IDLE ──(enable)──→ LISTENING ──(trigger detected)──→ CAPTURING ──(3s silence)──→ COOLDOWN ──(0.3s)──→ IDLE → LISTENING
                       ↑                                  │
                       └───────(cancel/stop command)──────┘
```

### 2. Priority Arbitration via triggerPaused

```swift
// SpeechService.swift:245-258
public func pauseTriggerForTTS() {
    if triggerState == .listening || triggerState == .capturing {
        stopTriggerListening()
        triggerPaused = true
    }
}

public func resumeTriggerIfPaused() {
    if triggerPaused {
        triggerPaused = false
        try? startTriggerListening()
    }
}
```

Manual mic uses the same pattern inline:
```swift
// startListening() pauses trigger
if triggerState == .listening || triggerState == .capturing {
    stopTriggerListening()
    triggerPaused = true
}

// stopListening() resumes trigger
if triggerPaused {
    triggerPaused = false
    try? startTriggerListening()
}
```

### 3. Silence Timer for Auto-Send

```swift
// SpeechService.swift:430-438
private func resetSilenceTimer() {
    silenceTask?.cancel()
    silenceTask = Task { @MainActor [weak self] in
        try? await Task.sleep(for: .seconds(Self.silenceTimeout))
        guard !Task.isCancelled, let self else { return }
        guard self.triggerState == .capturing else { return }
        self.sendCapturedCommand()
    }
}
```

Every time `handleTriggerResult` sees new text (detected by `trimmed.count > lastTranscriptLength`), it resets the timer. Three seconds of silence auto-sends.

### 4. Generation Counter for Stale Callbacks

```swift
// SpeechService.swift:264,298-300
private func beginRecognition() {
    let gen = recognitionGeneration
    // ...
    recognitionTask = speechRecognizer?.recognitionTask(with: request) { [weak self] result, error in
        Task { @MainActor [weak self] in
            guard let self, gen == self.recognitionGeneration else { return }
            // Process result...
        }
    }
}
```

`recognitionGeneration` is incremented before every new session. Stale callbacks from old sessions see a mismatched generation and bail.

### 5. 55-Second Restart with State Preservation

```swift
// SpeechService.swift:345-355
private func restartTriggerRecognition() {
    restartTask?.cancel()
    restartTask = nil
    recognitionGeneration += 1
    teardownRecognition()
    // capturedCommand and triggerState are preserved
    guard triggerState == .listening || triggerState == .capturing else { return }
    beginRecognition()
}
```

### 6. Background Audio Configuration

Info.plist declares `UIBackgroundModes: audio`. Audio session adds `.mixWithOthers` when trigger is enabled:

```swift
// SpeechService.swift:95-102
public func configureAudioSession(forBackground: Bool = false) throws {
    let session = AVAudioSession.sharedInstance()
    var options: AVAudioSession.CategoryOptions = [.defaultToSpeaker, .allowBluetooth]
    if forBackground { options.insert(.mixWithOthers) }
    try session.setCategory(.playAndRecord, options: options)
    try session.setActive(true, options: forBackground ? .notifyOthersOnDeactivation : [])
}
```

### 7. UserDefaults Persistence + Launch Restore

```swift
// AppCoordinator.swift
public func setTriggerEnabled(_ enabled: Bool) {
    state.triggerEnabled = enabled
    UserDefaults.standard.set(enabled, forKey: Self.triggerEnabledKey)
    if enabled {
        try? speechService.configureAudioSession(forBackground: true)
        try? speechService.startTriggerListening()
    } else {
        speechService.stopTriggerListening()
        try? speechService.configureAudioSession(forBackground: false)
    }
}
```

On launch, `AppCoordinator.init` reads the persisted flag and `ClaudeRemoteApp.swift` restores trigger listening if it was previously enabled.

## Prevention Strategies

### Priority Arbitration Checklist

- [ ] Call `pauseTriggerForTTS()` BEFORE any higher-priority audio operation
- [ ] Guarantee symmetric `resumeTriggerIfPaused()` after every pause
- [ ] Guard `startTriggerListening()` against already-active states
- [ ] Register `AVAudioSession.interruptionNotification` (once only) for system interruptions
- [ ] Test rapid mode switching: manual mic → stop → trigger resumes

### Recognition Lifecycle Checklist

- [ ] Increment `recognitionGeneration` before every new session
- [ ] Check `gen == self.recognitionGeneration` as first line of every callback
- [ ] Cancel `restartTask` before teardown to prevent double-restart
- [ ] Preserve `capturedCommand` across restarts; only clear on cancel/send
- [ ] Schedule 55-second restart (Apple's 60s limit minus buffer)

### Platform Testing Checklist

- [ ] Pure logic in separate files with `import Foundation` only
- [ ] No `#if os(iOS)` in extracted utility files
- [ ] Delegate from platform-gated code to platform-neutral utility
- [ ] All detection/matching tests run on macOS test runner

### Best Practices

| Pattern | Why | How |
|---------|-----|-----|
| triggerPaused flag | Prevents audio engine conflicts | Cooperative yielding, not mutex |
| Generation counter | Rejects stale async callbacks | Increment before new session, check in callback |
| State preservation on restart | Prevents command loss at 55s boundary | teardownRecognition() only touches engine, not app state |
| Platform-neutral extraction | Enables macOS CI testing | Pure enum with static methods, Foundation only |
| Single observer registration | Prevents duplicate interruption handlers | Guard `interruptionObserver == nil` |
| Background audio session | Keeps engine alive through screen lock | UIBackgroundModes + .mixWithOthers |

## Common Pitfalls

| Pitfall | Consequence | Prevention |
|---------|-------------|------------|
| Double `beginRecognition()` without teardown | AVAudioEngine throws; crash | Always call `teardownRecognition()` first |
| Missing `removeTap(onBus: 0)` in teardown | Audio buffers accumulate; garbled audio | Include in `teardownRecognition()` |
| Stale callback writes to transcript | State corruption from old session | Generation counter check |
| `capturedCommand` reset during restart | User's command silently dropped | Only clear in `cancelCapture()`/`sendCapturedCommand()` |
| Trigger not paused before TTS | Mic picks up speaker output as trigger | `pauseTriggerForTTS()` before every `speak()` |
| Observer registered multiple times | Duplicate interruption handlers fire | Guard `interruptionObserver == nil` |
| Trigger paused but never resumed | Silent zombie state; trigger dead | Symmetric pause/resume pairs; test both paths |

## Related Documentation

- [iOS Native App Plan](/docs/plans/2026-01-30-feat-ios-native-app-plan.md) — Phase 5 spec (lines 455-538): state machine, audio session, priority arbitration
- [Voice I/O Phase 4 Review Fixes](voice-io-phase4-review-fixes.md) — Generation counter pattern, observer lifecycle, platform-neutral extraction (VoicePromptMatcher)
- [Swift Structured Concurrency Pitfalls](../logic-errors/swift-structured-concurrency-pitfalls-observable-classes.md) — Task cancellation patterns, retain cycle prevention, fire-and-forget Task tracking
- [SwiftUI Review Findings Consolidation](../code-quality/swiftui-review-findings-consolidation.md) — nonisolated(unsafe) for globals, component extraction patterns
- [Triaging Multi-Agent Review Findings](../integration-issues/triaging-multi-agent-review-findings.md) — Review triage methodology, Swift 6 concurrency gotchas
