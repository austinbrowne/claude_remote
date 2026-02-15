---
module: iOS Voice I/O (SpeechService)
date: 2026-02-08
problem_type: runtime_error
component: service
symptoms:
  - "kAFAssistantErrorDomain error 1 even with all permissions granted"
  - "Speech recognition fails silently — recognition task callback error swallowed"
  - "Mic works on some devices but not others"
root_cause: missing_validation
resolution_type: code_fix
severity: high
tags: [sfspeechrecognizer, isavailable, siri, speech-delegate, kAFAssistantErrorDomain, recognizer-unavailable]
language: swift
framework: swiftui
issue_ref: "#10, #11"
related_solutions:
  - docs/solutions/runtime-errors/ios-dual-permission-mic-and-speech-20260208.md
---

# SFSpeechRecognizer: Authorization != Availability — Must Check isAvailable and Monitor Delegate

## Problem

Speech recognition fails with `kAFAssistantErrorDomain error 1` even when both microphone and speech recognition permissions are granted. The recognizer can be *authorized* but *unavailable* — for example, when Siri is disabled in Settings or there's no network for server-based recognition.

## Environment

- Module: iOS Voice I/O (SpeechService)
- Language/Framework: Swift 6 / SwiftUI
- iOS 17+

## Symptoms

- `kAFAssistantErrorDomain error 1` with permissions granted
- Recognition task callback returns error but code silently calls `stopListening()` without surfacing it
- No `SFSpeechRecognizerDelegate` implemented — availability changes go unnoticed

## What Didn't Work

**Only checking `SFSpeechRecognizer.authorizationStatus()`.**
Authorization is a privacy gate (user consent). Availability is a system state (hardware, Siri, network). They're independent.

**Silently stopping on recognition task error.**
The recognition task callback had `if error != nil { stopListening() }` with no error surfacing. Users saw the mic icon toggle off with no explanation.

## Solution

### 1. Check `isAvailable` before starting

```swift
guard let speechRecognizer, speechRecognizer.isAvailable else {
    throw SpeechError.recognizerUnavailable
}
```

### 2. Implement SFSpeechRecognizerDelegate

```swift
private final class RecognizerDelegate: NSObject, SFSpeechRecognizerDelegate, @unchecked Sendable {
    var onAvailabilityChanged: ((Bool) -> Void)?

    func speechRecognizer(_ speechRecognizer: SFSpeechRecognizer, availabilityDidChange available: Bool) {
        onAvailabilityChanged?(available)
    }
}
```

### 3. Surface recognition task errors with actionable messages

```swift
if let error {
    let nsError = error as NSError
    let isCancellation = nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 4
    if !isCancellation {
        self.onError?(Self.friendlyError(nsError))
    }
}

private static func friendlyError(_ error: NSError) -> String {
    if error.domain == "kAFAssistantErrorDomain" {
        switch error.code {
        case 1: return "Speech recognition unavailable — check that Siri is enabled in Settings"
        case 2: return "Speech recognition service error — try again"
        case 3: return "Speech recognition not authorized"
        default: return "Speech recognition error (\(error.code)) — try again"
        }
    }
    return "Mic error: \(error.localizedDescription)"
}
```

## Why This Works

`SFSpeechRecognizer.isAvailable` reflects the system's ability to perform recognition, not just the user's permission. Common causes of `isAvailable == false`:
- Siri is disabled in Settings
- No network (for server-based recognition on devices without on-device model)
- Device doesn't support the requested locale

The delegate monitors changes, so the app can react to Siri being toggled while the app is running.

## Prevention

- **Always check `isAvailable` in addition to `authorizationStatus`.** Authorization is necessary but not sufficient.
- **Always surface recognition task callback errors.** Code 4 is normal cancellation (suppress), but codes 1-3 need user-facing messages.
- **Map kAFAssistantErrorDomain codes to actionable text.** "Error 1" means nothing to users; "check that Siri is enabled" tells them what to do.
- **Implement `SFSpeechRecognizerDelegate`** to monitor availability changes at runtime.
