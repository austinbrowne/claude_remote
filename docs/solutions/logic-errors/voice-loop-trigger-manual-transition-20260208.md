---
title: "Voice loop non-functional from trigger activation path — cooldown always resumes trigger mode"
module: ClaudeRemote iOS
date: 2026-02-08
problem_type: logic_error
component: service
symptoms:
  - "Voice loop activated (isVoiceLoopActive = true) but never captures or sends input"
  - "onManualAutoSend callback never fires despite voice loop being active"
  - "After trigger word command sent, SpeechService resumes trigger listening instead of manual listening"
  - "Voice loop feature entirely non-functional from its primary activation path (trigger word)"
root_cause: async_timing
resolution_type: code_fix
severity: critical
language: swift
tags: [voice-loop, trigger-word, state-transition, callback, cooldown, speech-service, async-timing, ios]
related_solutions:
  - "concurrency-issues/trigger-word-phase5-audio-arbitration"
---

# Voice Loop Trigger→Manual Mode Transition Bug

## Problem Statement

The voice loop feature (continuous listen→send→listen) was entirely non-functional when activated from the trigger word flow. The user would say "Titus, start voice loop" and `isVoiceLoopActive` would be set to `true` in AppCoordinator, but no voice input was ever captured or sent. The feature worked conceptually but the mode transition from trigger to manual listening never happened.

## Environment

- iOS 18 / Swift 6
- SpeechService with 4-state trigger machine (idle/listening/capturing/cooldown)
- AppCoordinator managing voice loop lifecycle
- SFSpeechRecognizer with on-device recognition for trigger mode

## Symptoms

1. User activates voice loop via trigger word command
2. `isVoiceLoopActive` is set to `true`
3. Trigger word captured command is sent successfully
4. SpeechService enters cooldown state
5. After cooldown, SpeechService resumes **trigger** listening (waiting for "Titus" again)
6. `onManualAutoSend` never fires because SpeechService is in trigger mode, not manual mode
7. Voice loop appears active (UI shows it) but does nothing

## Root Cause

`sendCapturedCommand()` in SpeechService had a hardcoded cooldown that unconditionally called `startTriggerListening()`:

```swift
// BEFORE (broken)
cooldownTask = Task { @MainActor [weak self] in
    try? await Task.sleep(for: .seconds(Self.cooldownDuration))
    guard !Task.isCancelled, let self else { return }
    self.triggerState = .idle
    _ = try? self.startTriggerListening()  // Always resumes trigger!
}
```

SpeechService had no way to know that AppCoordinator wanted manual listening mode after the cooldown. The coordinator set `isVoiceLoopActive = true` but SpeechService doesn't know about voice loops — it only knows trigger mode and manual mode.

## What Didn't Work

- **Checking `isVoiceLoopActive` in SpeechService** — violates separation of concerns; SpeechService shouldn't know about voice loop state
- **Starting manual listening immediately after setting `isVoiceLoopActive`** — conflicts with the still-active trigger cooldown; two recognition tasks crash

## Solution

Added an `onCooldownComplete` callback to SpeechService, letting AppCoordinator decide what happens after trigger cooldown:

```swift
// SpeechService.swift
/// Called when trigger cooldown completes — allows AppCoordinator to decide
/// whether to resume trigger listening or transition to voice loop (manual mode).
public var onCooldownComplete: (() -> Void)?

// In sendCapturedCommand():
cooldownTask = Task { @MainActor [weak self] in
    try? await Task.sleep(for: .seconds(Self.cooldownDuration))
    guard !Task.isCancelled, let self, self.triggerState == .cooldown else { return }
    self.triggerState = .idle
    if let onCooldownComplete = self.onCooldownComplete {
        onCooldownComplete()
    } else {
        _ = try? self.startTriggerListening()  // Default: resume trigger
    }
}
```

```swift
// AppCoordinator.swift — wired in init
speechService.onCooldownComplete = { [weak self] in
    guard let self else { return }
    if self.isVoiceLoopActive {
        // Transition from trigger to manual listening for voice loop
        do {
            try self.speechService.startListening()
            self.voiceLoopRetryCount = 0
        } catch {
            self.scheduleVoiceLoopRetry()
        }
    } else {
        // Normal trigger flow — resume trigger listening
        _ = try? self.speechService.startTriggerListening()
    }
}
```

## Why This Works

- **Separation of concerns preserved** — SpeechService doesn't know about voice loops; it just calls a callback
- **No timing conflicts** — the callback fires after cooldown completes and `triggerState` is `.idle`, so starting manual listening is safe
- **Default behavior preserved** — if no callback is set (nil), falls back to original `startTriggerListening()` behavior
- **Extensible** — any future feature needing post-cooldown behavior can use the same callback

## Prevention Strategies

| Pattern | Why | How |
|---------|-----|-----|
| Callback for mode transitions | Lower-level service can't know all caller contexts | Provide callback hook instead of hardcoding next action |
| Test the primary activation path | Feature was tested in isolation but not end-to-end from trigger | Integration test: trigger word → cooldown → voice loop starts |
| Review state machine transitions | Bugs hide at transition boundaries | Trace every state exit and verify the next state is correct for all callers |
| Fresh Eyes Review catches what author misses | Three independent reviewers flagged this as CRITICAL | Multi-agent review with zero-context methodology |

## Common Pitfalls

| Pitfall | Consequence | Prevention |
|---------|-------------|------------|
| Hardcoded next-state in cooldown | Can't support multiple callers with different intentions | Use callback or delegate pattern |
| Testing feature in isolation only | Miss integration bugs at component boundaries | Test full activation flow end-to-end |
| Assuming trigger flow always returns to trigger | Voice loop needs manual mode after trigger command | Make post-cooldown behavior configurable |

## Related Documentation

- [Phase 5: Trigger Word Audio Arbitration](../concurrency-issues/trigger-word-phase5-audio-arbitration.md) — trigger state machine design
- [Voice I/O Phase 4 Review Fixes](../concurrency-issues/voice-io-phase4-review-fixes.md) — generation counter pattern
