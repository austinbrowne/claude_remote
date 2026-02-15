---
module: iOS Voice I/O (SpeechService)
date: 2026-02-08
problem_type: runtime_error
component: service
symptoms:
  - "kAFAssistantErrorDomain error 1 when tapping mic button"
  - "Mic button does nothing — no audio, no transcript, no error"
  - "Speech recognition fails even after granting microphone permission"
root_cause: missing_permission
resolution_type: code_fix
severity: high
tags: [avaudiosession, record-permission, sfspeechrecognizer, microphone, speech-recognition, ios-permissions, kAFAssistantErrorDomain]
language: swift
framework: swiftui
issue_ref: "#10, #11"
related_solutions:
  - docs/solutions/runtime-errors/setactive-mainactor-freeze-crash-loop-20260206.md
---

# iOS Requires TWO Separate Permissions for Speech: Microphone AND Speech Recognition

## Problem

Tapping the mic button produces `kAFAssistantErrorDomain error 1` or silently fails. The app only checks `SFSpeechRecognizer.authorizationStatus()` but never checks `AVAudioSession.recordPermission`. iOS treats these as two independent privacy permissions.

## Environment

- Module: iOS Voice I/O (SpeechService)
- Language/Framework: Swift 6 / SwiftUI
- iOS 17+

## Symptoms

- `kAFAssistantErrorDomain error 1` — cryptic error meaning "recognizer unavailable"
- Mic button appears to do nothing — starts then immediately fails
- Works on Simulator (which auto-grants permissions) but fails on device

## What Didn't Work

**Assumed speech recognition authorization covers microphone access.**
iOS has two separate permission gates:
1. `SFSpeechRecognizer.requestAuthorization` — "Allow speech recognition?"
2. `AVAudioApplication.requestRecordPermission` — "Allow microphone access?"

Both must be `.authorized` / `.granted` before recognition can start.

## Solution

Check microphone permission AFTER speech recognition authorization, in both `startListening()` and `startTriggerListening()`:

```swift
// After speech recognition auth check passes...

let micStatus = AVAudioApplication.shared.recordPermission
if micStatus == .undetermined {
    AVAudioApplication.requestRecordPermission { [weak self] granted in
        Task { @MainActor in
            guard let self else { return }
            if granted {
                do { try self.startListening() }
                catch { self.onError?("Mic failed: \(error.localizedDescription)") }
            } else {
                self.onError?(SpeechError.microphoneDenied.description)
            }
        }
    }
    return
}
guard micStatus == .granted else {
    throw SpeechError.microphoneDenied
}
```

Added `SpeechError.microphoneDenied` with actionable message: "Microphone permission denied — enable in Settings > Privacy > Microphone"

## Why This Works

iOS enforces microphone and speech recognition as independent privacy permissions. The speech recognizer uses the microphone internally, but iOS doesn't auto-prompt for mic access when you request speech recognition. You must explicitly request both.

## Prevention

- **Always check both permissions before starting speech recognition.** Order: speech recognition first (since it's the less common one users expect), then microphone.
- **Add a dedicated error case** with Settings directions so users know what to do.
- **Test on a real device** — Simulator auto-grants permissions and hides this bug.
- **After denying a permission in Settings, user must delete and reinstall the app** (or manually toggle in Settings > Privacy) to get the prompt again.
