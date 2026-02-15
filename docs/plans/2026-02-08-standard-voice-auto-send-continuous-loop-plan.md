---
title: "Voice Auto-Send + Continuous Voice Loop"
date: 2026-02-08
tier: standard
status: REVISED
brainstorm_ref: docs/brainstorms/2026-02-08-voice-auto-send-loop-brainstorm.md
tags: [voice, auto-send, continuous-loop, auto-mode, trigger-word, speech]
---

# Plan: Voice Auto-Send + Continuous Voice Loop

**Tier:** Standard
**Status:** REVISED (post-review)
**Feeds from:** `docs/brainstorms/2026-02-08-voice-auto-send-loop-brainstorm.md`

## Problem

Voice is the key feature but has critical friction:
1. Manual mic requires user to tap "Send" after dictating — no auto-send
2. Auto-mode (voice prompt responses) exists but is disconnected from trigger word mode
3. After sending a voice message, listening stops — no continuous conversation loop

## Goals

- Dictated messages auto-send after silence (no manual tap needed)
- Trigger word mode implicitly enables auto-mode for prompt responses
- After voice-send, keep listening for the next command (continuous loop)
- "Stop listening" / "that's all" commands exit the voice loop
- Tapping mic button exits the voice loop (reliable non-voice escape)
- No regression to manual text input flow

## Solution

Two phases, building incrementally:

**Phase 1 — Silence Auto-Send + Trigger Enables Auto-Mode:**
- Add silence detection to manual mic mode (parameterize existing `resetSilenceTimer`)
- When trigger mode is enabled, implicitly enable auto-mode
- Wire `onTranscriptUpdate` for auto-mode prompt matching

**Phase 2 — Continuous Voice Loop:**
- After silence auto-send, AppCoordinator restarts listening (not SpeechService)
- Add voice loop state (`isVoiceLoopActive`) in AppCoordinator
- Add stop commands ("stop listening", "that's all") detected in AppCoordinator
- Tapping mic or text field exits the loop
- Keep listening through prompt responses (TTS → listen → match → keep going)
- Retry/backoff on recognition failure (reuse trigger mode pattern)

## Architecture Principles (from review)

1. **SpeechService = audio infrastructure.** It emits data (transcripts), manages hardware (audio engine, recognition). It does NOT interpret meaning or make business decisions.
2. **AppCoordinator = business logic.** It decides when to send commands, when to restart listening, when to exit the loop. Voice loop state lives here.
3. **`stopListening()` stays a clean teardown.** It always stops. AppCoordinator calls `startListening()` again when it wants to loop.
4. **VoicePromptMatcher = prompt response matching only.** Stop commands are not prompt responses — they're handled separately.

## Technical Approach

### Phase 1 Changes

**File: `SpeechService.swift`**

1. **Parameterize the silence timer** — refactor `resetSilenceTimer()` to accept a timeout and callback, used by both trigger and manual modes:
   ```swift
   /// Shared silence timer — used by trigger capture (3s) and manual auto-send
   private func resetSilenceTimer(timeout: TimeInterval, action: @escaping () -> Void) {
       silenceTask?.cancel()
       silenceTask = Task { @MainActor [weak self] in
           try? await Task.sleep(for: .seconds(timeout))
           guard !Task.isCancelled, let self else { return }
           action()
       }
   }
   ```
   Update existing trigger `resetSilenceTimer()` call sites to use `resetSilenceTimer(timeout: Self.silenceTimeout) { self.sendCapturedCommand() }`.

2. **Add manual silence detection** in the recognition callback (lines 628-632):
   - New callback: `var onManualAutoSend: ((String) -> Void)?`
   - New property: `private var lastManualTranscriptLength = 0`
   - In the `!isInTriggerMode` branch, when `!text.isEmpty`:
     - If `text.count > lastManualTranscriptLength` → reset silence timer with `timeout: Self.silenceTimeout` (3s, same as trigger — tune later with user data)
     - `lastManualTranscriptLength = text.count`
     - On timeout → fire `onManualAutoSend?(transcript)` (SpeechService does NOT call stopListening — that's AppCoordinator's job)
   - Reset `lastManualTranscriptLength = 0` in `startListening()` (line 399)
   - Guard in timer: `guard !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty` — empty transcript does not auto-send

3. **Add `cancelManualSilenceTimer()` public method** — called by AppCoordinator on manual send or mic toggle:
   ```swift
   public func cancelManualSilenceTimer() {
       guard !isInTriggerMode else { return }
       silenceTask?.cancel()
       silenceTask = nil
   }
   ```

**File: `AppCoordinator.swift`**

4. **Wire `onManualAutoSend` callback** in `init()`:
   ```swift
   speechService.onManualAutoSend = { [weak self] text in
       self?.handleVoiceAutoSend(text)
   }
   ```

5. **`handleVoiceAutoSend(_ text:)`** — unified handler for both trigger and manual auto-send:
   ```swift
   private func handleVoiceAutoSend(_ text: String) {
       guard let sessionId = state.currentSessionId else { return }
       // Suppress auto-send when a permission prompt is active — prevent ambient audio
       // from approving permissions via the auto-mode matching pipeline
       if promptService.currentPrompt != nil {
           return  // Let the user respond to the prompt manually or via voice match
       }
       HapticService.heavy()
       state.trackSentMessage(text)
       injectCommand(text, sessionId: sessionId)
       speechService.stopListening()
       // Phase 2: voice loop restart handled below
   }
   ```

6. **Trigger enabled → set `isAutoMode = true`** in `setTriggerEnabled(_ enabled:)`:
   - When enabling: `speechService.isAutoMode = true`
   - When disabling: `speechService.isAutoMode = false`
   - Note: This is an intentional UX simplification. Users wanting trigger-without-auto-mode is an edge case we may revisit.

**File: `InputBarView.swift`**

7. **Update transcript → inputText sync** (lines 118-122):
   - Still update `inputText` from transcript for visual feedback while listening
   - After auto-send, `speechService.stopListening()` sets `isListening = false`, so transcript updates stop

8. **Clear inputText after auto-send** — add `.onChange(of: speechService.isListening)`:
   ```swift
   .onChange(of: speechService.isListening) { wasListening, isListening in
       if wasListening && !isListening && !speechService.transcript.isEmpty {
           inputText = ""  // Clear after auto-send or manual stop
       }
   }
   ```

9. **Cancel silence timer on manual send** — in `send()` (line 210), add:
   ```swift
   #if os(iOS)
   speechService.cancelManualSilenceTimer()
   if speechService.isListening { speechService.stopListening() }
   #endif
   ```

### Phase 2 Changes

**File: `AppCoordinator.swift`**

10. **Add `isVoiceLoopActive` state** in AppCoordinator (NOT SpeechService):
    ```swift
    private var isVoiceLoopActive = false
    // isVoiceLoopActive is intentionally NOT persisted — voice loops should not survive app restarts
    ```

11. **Voice loop restart in `handleVoiceAutoSend`** — after `speechService.stopListening()`:
    ```swift
    if isVoiceLoopActive {
        do {
            try speechService.startListening()
        } catch {
            // Recognition failed — use retry with backoff
            scheduleVoiceLoopRetry()
        }
    }
    ```

12. **Add `scheduleVoiceLoopRetry()`** — reuse trigger mode's exponential backoff pattern:
    ```swift
    private var voiceLoopRetryCount = 0
    private static let maxVoiceLoopRetries = 5
    private var voiceLoopRetryTask: Task<Void, Never>?

    private func scheduleVoiceLoopRetry() {
        guard voiceLoopRetryCount < Self.maxVoiceLoopRetries else {
            isVoiceLoopActive = false
            voiceLoopRetryCount = 0
            state.showToast("Voice loop stopped — tap mic to retry", icon: "mic.slash", style: .warning)
            return
        }
        let delay = Double(min(1 << voiceLoopRetryCount, 16))
        voiceLoopRetryCount += 1
        voiceLoopRetryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.isVoiceLoopActive else { return }
            do {
                try self.speechService.startListening()
                self.voiceLoopRetryCount = 0
            } catch {
                self.scheduleVoiceLoopRetry()
            }
        }
    }
    ```

13. **Stop command detection in `handleVoiceAutoSend`** — check BEFORE injecting:
    ```swift
    private static let stopPhrases = ["stop listening", "that's all"]

    private func handleVoiceAutoSend(_ text: String) {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !cleaned.isEmpty else { return }
        guard let sessionId = state.currentSessionId else { return }

        // Check if the ENTIRE transcript is a stop command
        if isVoiceLoopActive && Self.stopPhrases.contains(cleaned) {
            exitVoiceLoop()
            return
        }

        // Suppress auto-send during active permission prompts
        if promptService.currentPrompt != nil { return }

        HapticService.heavy()
        state.trackSentMessage(text)
        injectCommand(text, sessionId: sessionId)
        speechService.stopListening()

        if isVoiceLoopActive {
            do {
                try speechService.startListening()
                voiceLoopRetryCount = 0
            } catch {
                scheduleVoiceLoopRetry()
            }
        }
    }
    ```

14. **`exitVoiceLoop()`** — clean exit with feedback:
    ```swift
    private func exitVoiceLoop() {
        isVoiceLoopActive = false
        voiceLoopRetryCount = 0
        voiceLoopRetryTask?.cancel()
        voiceLoopRetryTask = nil
        speechService.stopListening()
        HapticService.medium()
        state.showToast("Voice loop ended", icon: "mic.slash", style: .info)
    }
    ```

15. **Start voice loop from trigger command** — in `handleTriggerCommand`:
    ```swift
    private func handleTriggerCommand(_ command: String) {
        guard let sessionId = state.currentSessionId else { ... }
        HapticService.heavy()
        state.trackSentMessage(command)
        injectCommand(command, sessionId: sessionId)
        isVoiceLoopActive = true  // Continue listening after trigger command
        voiceLoopRetryCount = 0
    }
    ```

16. **Clear `isVoiceLoopActive` on all exit paths:**
    - `cancelAutoModeSpeech()`: add `isVoiceLoopActive = false; voiceLoopRetryTask?.cancel()`
    - `watchSession()`: already calls `cancelAutoModeSpeech()` — covered
    - `setTriggerEnabled(false)`: add `isVoiceLoopActive = false; voiceLoopRetryTask?.cancel()`
    - `webSocketDidDisconnect()`: add via `cancelAutoModeSpeech()` call
    - `restoreTriggerIfNeeded()`: if voice loop was active, show toast "Voice loop ended — backgrounded"

17. **Handle recognition errors during voice loop** — update `onError` callback in `init()`:
    ```swift
    speechService.onError = { [weak self] message in
        guard let self else { return }
        self.state.showToast(message, icon: "mic.slash", style: .warning)
        // If voice loop is active and recognition errored, retry
        if self.isVoiceLoopActive && !self.speechService.isListening {
            self.scheduleVoiceLoopRetry()
        }
        // ... existing trigger toggle reset ...
    }
    ```

**File: `InputBarView.swift`**

18. **Tap mic exits voice loop** — in mic button action:
    ```swift
    action: {
        if coordinator.isVoiceLoopActive && speechService.isListening {
            coordinator.exitVoiceLoop()  // Make public
        } else {
            do {
                try speechService.toggleListening()
            } catch {
                state.showToast(...)
            }
        }
    }
    ```

19. **Tap text field exits voice loop** — detect keyboard focus:
    ```swift
    .onChange(of: isFocused) { _, focused in
        if focused && coordinator.isVoiceLoopActive {
            coordinator.exitVoiceLoop()
        }
    }
    ```

20. **Visual distinction for voice loop mode** — update mic button:
    ```swift
    utilityButton(
        icon: speechService.isListening
            ? (coordinator.isVoiceLoopActive ? "mic.badge.xmark" : "mic.fill")
            : "mic",
        label: speechService.isListening
            ? (coordinator.isVoiceLoopActive ? "Voice Loop" : "Listening")
            : "Mic",
        tint: speechService.isListening
            ? (coordinator.isVoiceLoopActive ? .green : .red)
            : .secondary,
        pulsing: speechService.isListening,
        ...
    )
    ```
    Voice loop = green pulsing mic with "Voice Loop" label. Single-shot = red pulsing mic with "Listening" label.

**File: `SpeechService.swift`**

21. **Set `requiresOnDeviceRecognition` for voice loop** — in `startRecognitionEngine()`:
    ```swift
    // Use on-device recognition for trigger mode AND when voice loop is active (privacy, battery)
    // Voice loop flag is checked via a new property set by AppCoordinator
    if isInTriggerMode || preferOnDeviceRecognition {
        if speechRecognizer?.supportsOnDeviceRecognition == true {
            request.requiresOnDeviceRecognition = true
        }
    }
    ```
    Add `public var preferOnDeviceRecognition = false` — set by AppCoordinator when entering voice loop.

## Implementation Steps

| Step | Phase | File | Description |
|------|-------|------|-------------|
| 1 | P1 | SpeechService.swift | Parameterize `resetSilenceTimer(timeout:action:)`, update trigger call sites |
| 2 | P1 | SpeechService.swift | Add `onManualAutoSend` callback, manual silence detection in recognition callback, `cancelManualSilenceTimer()` |
| 3 | P1 | AppCoordinator.swift | Wire `onManualAutoSend`, implement `handleVoiceAutoSend` (suppress during prompts) |
| 4 | P1 | AppCoordinator.swift | Trigger enabled → set `isAutoMode = true` |
| 5 | P1 | InputBarView.swift | Clear inputText after auto-send, cancel silence timer on manual send |
| 6 | P1 | Tests | Test silence timer, auto-send callback, trigger→auto-mode, empty transcript guard, manual-send-cancels-timer |
| 7 | P2 | AppCoordinator.swift | Add `isVoiceLoopActive`, `exitVoiceLoop()`, clear on all exit paths |
| 8 | P2 | AppCoordinator.swift | Add `scheduleVoiceLoopRetry()` with exponential backoff (maxRetries=5) |
| 9 | P2 | AppCoordinator.swift | Stop command detection (entire-transcript match, "stop listening"/"that's all") |
| 10 | P2 | AppCoordinator.swift | Voice loop restart in `handleVoiceAutoSend`, trigger→voice loop in `handleTriggerCommand` |
| 11 | P2 | AppCoordinator.swift | Handle recognition errors during voice loop (retry via onError callback) |
| 12 | P2 | InputBarView.swift | Tap mic exits loop, tap text field exits loop, green "Voice Loop" indicator |
| 13 | P2 | SpeechService.swift | `preferOnDeviceRecognition` flag for privacy during voice loop |
| 14 | P2 | Tests | Test loop restart, stop commands (exact match), retry/backoff, exit paths, visual state |

## Affected Files

| File | Change |
|------|--------|
| `SpeechService.swift` | Parameterized silence timer, manual auto-send callback, `cancelManualSilenceTimer()`, `preferOnDeviceRecognition` |
| `AppCoordinator.swift` | Voice auto-send handler, trigger→auto-mode, `isVoiceLoopActive`, stop commands, retry/backoff, exit cleanup |
| `InputBarView.swift` | Clear text after auto-send, cancel timer on manual send, voice loop UI, tap-to-exit |

## Acceptance Criteria

**Phase 1:**
- [ ] Manual mic: after 3s of silence, transcript auto-sends without tap
- [ ] Empty transcript after silence does NOT auto-send
- [ ] User sees transcript in text field while dictating (visual feedback)
- [ ] Text field clears after auto-send
- [ ] Haptic feedback on auto-send
- [ ] Manual send before timeout cancels the silence timer (no double send)
- [ ] Auto-send suppressed when a permission prompt is active
- [ ] Enabling trigger mode also enables auto-mode
- [ ] Disabling trigger mode also disables auto-mode
- [ ] Prompts auto-speak + listen when auto-mode is on
- [ ] Manual text input still works normally (no regression)

**Phase 2:**
- [ ] After voice auto-send, mic stays active — listening restarts
- [ ] Mic button shows green "Voice Loop" indicator during loop
- [ ] "Stop listening", "that's all" exits the voice loop (entire transcript must match)
- [ ] Tapping mic during voice loop exits the loop
- [ ] Tapping text field during voice loop exits the loop
- [ ] Toast shown on voice loop exit ("Voice loop ended")
- [ ] When prompt appears during voice loop: TTS speaks → listen → match → loop continues
- [ ] Trigger word activates voice loop (stays listening after initial command)
- [ ] Voice loop respects audio priority (pauses for TTS, resumes after)
- [ ] Recognition errors during voice loop use exponential backoff (maxRetries=5)
- [ ] After max retries, voice loop exits with toast
- [ ] Session switch/disconnect/trigger-disable all exit voice loop
- [ ] App backgrounding exits voice loop with toast on return
- [ ] Voice loop uses on-device recognition when available (privacy)
- [ ] `isVoiceLoopActive` is NOT persisted across app restarts

## Spec-Flow Analysis

**Flow: Manual mic auto-send**
1. User taps mic → listening starts → transcript updates text field
2. User stops talking → 3s silence → auto-send → text field clears → mic stops
3. Edge: empty transcript → silence timer fires → guard skips send
4. Edge: user starts talking again before timeout → timer resets (text grew)
5. Edge: user taps send manually before timeout → `cancelManualSilenceTimer()`, normal send
6. Edge: permission prompt active → auto-send suppressed, transcript stays in text field

**Flow: Continuous voice loop**
1. Auto-send fires → command injected → `stopListening()` → AppCoordinator calls `startListening()` again
2. Claude processes → prompt appears → TTS speaks → listen → match → respond → loop restarts
3. Claude processes → no prompt → user speaks next command → auto-send → loop
4. Edge: user says "stop listening" (entire transcript) → `exitVoiceLoop()`, mic turns off, toast shown
5. Edge: user taps mic → `exitVoiceLoop()`, reliable non-voice escape
6. Edge: user taps text field → `exitVoiceLoop()`, switches to manual input
7. Edge: recognition fails → `scheduleVoiceLoopRetry()` with backoff → retry up to 5 times
8. Edge: 5 retries exhausted → `exitVoiceLoop()` with "tap mic to retry" toast
9. Edge: session switches during loop → `cancelAutoModeSpeech()` → `isVoiceLoopActive = false`
10. Edge: app backgrounds → voice loop exits, toast on return

**Flow: Trigger word → voice loop**
1. "Titus, check the tests" → trigger captures → `handleTriggerCommand` → auto-send
2. `isVoiceLoopActive = true` → listening continues
3. Permission prompt appears → auto-send suppressed → TTS: "Allow Bash? Say allow, always, or deny"
4. User: "always" → matched via `handleVoiceResponse` → permission granted → loop continues
5. Claude finishes → user: "stop listening" → `exitVoiceLoop()`

**Flow: Stop commands**
1. Stop commands are checked in `handleVoiceAutoSend` BEFORE injecting
2. Match requires entire transcript == stop phrase (lowercased, trimmed)
3. "stop listening" → exits loop. "that's all" → exits loop.
4. "I'm done with the tests" → NOT a stop command (partial match rejected)
5. "stop" alone → NOT a stop command (too ambiguous, conflicts with trigger cancel)
6. When a prompt is active → stop commands still work (checked before prompt suppression)

## Test Strategy

- Parameterized silence timer: test that both trigger and manual modes use same timer with different configs
- Manual silence: test `onManualAutoSend` fires after silence, does not fire on empty transcript
- Timer cancellation: test `cancelManualSilenceTimer()` prevents double-send on manual send
- Prompt suppression: test auto-send does not inject when `currentPrompt != nil`
- Trigger→auto-mode: verify `isAutoMode` toggled with `triggerEnabled`
- Voice loop restart: verify `startListening()` called after auto-send when `isVoiceLoopActive`
- Stop commands: verify exact-match only — "stop listening" exits, "I'm done" does NOT exit
- Retry/backoff: verify exponential backoff on recognition failure, exit after maxRetries
- Exit paths: verify `isVoiceLoopActive = false` on session switch, trigger disable, disconnect
- Visual state: verify green mic + "Voice Loop" label when loop active

## Review Findings Addressed

| Finding | Severity | Resolution |
|---------|----------|------------|
| Infinite restart on recognition failure (C-004) | CRITICAL | Added `scheduleVoiceLoopRetry()` with maxRetries=5 and exponential backoff |
| "done" false-positive on partials (FLOW-001) | CRITICAL | Removed "done" from stop commands. Require entire transcript == stop phrase |
| `.stopListening` in VoicePromptMatcher (SIMP-001) | CRITICAL | Removed. Stop detection handled in AppCoordinator's `handleVoiceAutoSend` |
| `stopListening()` overloaded (ARCH-001) | HIGH | `stopListening()` unchanged. AppCoordinator calls `startListening()` for loop restart |
| Manual send + silence timer race (C-003) | HIGH | Added `cancelManualSilenceTimer()`, called from `InputBarView.send()` |
| `isVoiceLoopActive` not cleared (C-005) | HIGH | Cleared in `cancelAutoModeSpeech()`, `setTriggerEnabled(false)`, backgrounding |
| Ambient audio approves permissions (C-006) | HIGH | Auto-send suppressed when `promptService.currentPrompt != nil` |
| Stop detection in SpeechService (ARCH-003) | HIGH | Moved to AppCoordinator |
| "done" during TTS lost (FLOW-003) | HIGH | Tap mic to exit loop as reliable fallback. TTS behavior documented |
| Manual typing overwrites (FLOW-004) | HIGH | Tapping text field (focus) exits voice loop |
| No visual distinction (FLOW-007) | HIGH | Green pulsing mic + "Voice Loop" label |
| `isVoiceLoopActive` in SpeechService (ARCH-002) | MEDIUM | Moved to AppCoordinator |
| Duplicate silence timer code (SIMP-002) | MEDIUM | Parameterized `resetSilenceTimer(timeout:action:)` |
| `isVoiceLoopActive` in Phase 1 (SIMP-004) | MEDIUM | Deferred to Phase 2 |
| Trigger-auto-mode coupling (C-002) | MEDIUM | Kept as intentional UX simplification, documented tradeoff |
| "stop" conflicts with isCancelCommand (SIMP-007) | MEDIUM | Dropped single-word "stop" from stop commands |
| Empty transcript guard (FLOW-008) | MEDIUM | Explicit guard in timer callback |
| App backgrounding (FLOW-009) | MEDIUM | Exit voice loop on background, toast on foreground return |
| 2s silence too short (FLOW-011) | MEDIUM | Changed to 3s (same as trigger), tune later with user data |
| Stop vs prompt precedence (FLOW-012) | MEDIUM | Stop commands checked first, then prompt suppression |
| Continuous listening privacy (SEC-003) | MEDIUM | `preferOnDeviceRecognition` flag for voice loop mode |

## Past Learnings Applied

- Silence timer pattern from trigger mode (3s, cancellable Task.sleep) — parameterized for reuse
- `cancelAutoModeSpeech()` cleanup — clears voice loop state on session switch
- `Task.isCancelled` after await — check in all TTS→listen transitions
- Audio priority via `triggerPaused` — voice loop pauses during TTS
- ALL CoreAudio ops off MainActor — new audio engine work in Task.detached
- Exponential backoff from `scheduleRetry()` — reused for voice loop retries
- First-word exact matching from VoicePromptMatcher — NOT applied to stop commands (entire-transcript match instead)

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| False auto-send (cough, background noise) | Medium | 3s timer gives buffer; user can interrupt by tapping send/mic; suppressed during prompts |
| "Stop listening" not recognized by speech recognizer | Low | Tap mic as reliable fallback; green "Voice Loop" indicator makes state visible |
| Battery drain from continuous listening | Low | Same as trigger mode; on-device recognition preferred; user-controlled exit |
| Audio session conflicts in loop | Low | Reuse existing `triggerPaused` cooperative yielding |
| Trigger-auto-mode coupling surprises users | Low | Intentional simplification; revisit if users report unwanted TTS |
