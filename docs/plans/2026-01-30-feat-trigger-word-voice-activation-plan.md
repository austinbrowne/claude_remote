---
title: "feat: Trigger word voice activation"
type: feat
date: 2026-01-30
---

# Trigger Word Voice Activation

## Overview

Add a "Titus mode" that listens for the trigger word "Titus" while the app is open. When detected, the app captures the user's spoken command, auto-sends it when they stop talking, then goes fully idle until the trigger word is heard again.

## Problem Statement

The current voice input is push-to-talk: tap the mic button, speak, then tap Send. This requires two manual interactions per voice command. A trigger word allows fully hands-free operation — say "Titus, check the test results" and the command sends automatically.

## Proposed Solution

### State Machine

```
  ┌───────────────────────────────────────────────┐
  │                                               │
  ▼                                               │
IDLE ──[toggle on]──> LISTENING ──[trigger]──> CAPTURING ──[silence]──> IDLE
                         │                        │
                         │                        └──[cancel/"stop"]──> IDLE
                         └──[toggle off]──> IDLE
```

Three states, one `SpeechRecognition` instance, behavior changes based on current state:

| State | Recognition | Behavior |
|-------|-------------|----------|
| **IDLE** | Stopped | No mic activity. Default state. |
| **LISTENING** | Running (auto-restart on end) | Scanning all transcripts for trigger word. Subtle UI indicator. |
| **CAPTURING** | Running | Accumulating speech into command buffer. Shows preview. Silence timeout auto-sends. |

### Trigger Word Detection

The word "Titus" may be misrecognized. Match against a variant list:

```javascript
const TRIGGER_WORD = 'titus';
const TRIGGER_VARIANTS = ['titus', 'tightest', 'tidus', 'tidas', 'titus,'];

function containsTrigger(text) {
  const lower = text.toLowerCase();
  return TRIGGER_VARIANTS.some(v => lower.includes(v));
}
```

Check both interim and final results for speed. The trigger word and anything before it is stripped — only text after "Titus" becomes the command.

### Command Capture & Auto-Send

After trigger detection, switch to CAPTURING state:

1. Accumulate `finalTranscript` segments into `commandBuffer`
2. Show interim preview in the command input field
3. Reset a silence timer on each new speech result
4. When silence timer fires (default 3 seconds), auto-send the command
5. Transition to IDLE (mic stops completely)

### Safari/iOS Compatibility

iOS Safari has critical bugs with `recognition.continuous = true` (duplicate transcripts, stuck mic, `isFinal` never becoming true). Use a restart-loop approach:

```javascript
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

// Safari: use continuous=false, restart on every onend
// Chrome: use continuous=true for seamless listening
recognition.continuous = !isIOS;
```

On iOS, `onend` fires after each utterance, and we immediately restart. This creates small gaps but avoids Safari's broken continuous mode.

### Coexistence with Existing Voice Features

The trigger word system must not break:

1. **Manual mic button** (`toggleVoiceInput`): If Titus mode is LISTENING and user taps the mic button, pause trigger listening, switch to manual mode. When manual recording ends, resume trigger listening.

2. **TTS speak-then-listen** (`speakThenListen`): During TTS playback, pause trigger listening (avoid picking up speaker audio). After TTS ends + the prompt listen cycle completes, resume trigger listening.

3. **Prompt voice responses** (`handleVoicePromptResponse`): If a prompt is active and trigger mode is on, the prompt system takes priority. After prompt is dismissed, resume trigger listening.

Priority order: **Prompt response > Manual mic > Trigger word listening**

## Technical Approach

### New State & Settings (`state.js`)

```javascript
// Trigger word state machine
const TRIGGER_STATE = { IDLE: 0, LISTENING: 1, CAPTURING: 2 };
let triggerState = TRIGGER_STATE.IDLE;
let triggerCommandBuffer = '';
let triggerSilenceTimer = null;
const TRIGGER_SILENCE_MS = 3000; // 3s silence = send command
const TRIGGER_RESTART_DELAY_MS = 300;
let triggerShouldRestart = false;

// Settings
// settings.triggerEnabled — persisted to localStorage
// settings.triggerWord — default 'titus', user-configurable later
```

### New Functions (`ui.js`)

```
Trigger word control:
  enableTriggerMode, disableTriggerMode, toggleTriggerMode

Recognition handling (extends existing onresult):
  handleTriggerResult — scans for trigger word in LISTENING state,
                        accumulates command in CAPTURING state

Command capture:
  startCapturing — transition to CAPTURING, play haptic, show UI
  resetTriggerSilenceTimer — reset the auto-send countdown
  finalizeTriggerCommand — auto-send the accumulated command
  cancelTriggerCapture — cancel without sending (user says "cancel"/"stop")

Restart loop:
  restartTriggerListening — called from onend when triggerShouldRestart is true

UI updates:
  updateTriggerUI — update mic button and status indicator for current state
```

### Recognition Result Routing (`init.js`)

Modify the `recognition.onresult` handler to route based on state:

```javascript
recognition.onresult = (event) => {
  // 1. If capturing a trigger command, route there first
  if (triggerState === TRIGGER_STATE.CAPTURING) {
    handleTriggerCapture(event);
    return;
  }

  // 2. If listening for trigger word, check for it
  if (triggerState === TRIGGER_STATE.LISTENING) {
    if (handleTriggerDetection(event)) return; // trigger found
    return; // still listening, don't put text in input
  }

  // 3. Existing behavior: prompt response or text input
  // ... (current code unchanged)
};
```

### Recognition Lifecycle (`init.js`)

Modify `recognition.onend` to support auto-restart:

```javascript
recognition.onend = () => {
  isRecording = false;
  document.getElementById('voiceBtn').classList.remove('recording');

  // Auto-restart for trigger word listening
  if (triggerShouldRestart && triggerState !== TRIGGER_STATE.IDLE) {
    setTimeout(() => {
      if (triggerShouldRestart) {
        try { recognition.start(); } catch (e) { /* already running */ }
      }
    }, TRIGGER_RESTART_DELAY_MS);
  }
};
```

### Settings Panel (`index.html`)

Add a toggle in the settings panel:

```html
<div class="setting-row">
  <label>
    <input type="checkbox" id="triggerEnabled" onchange="updateSettings()">
    Voice trigger word ("Titus")
  </label>
</div>
```

### UI Indicators

When trigger mode is active:

- **LISTENING state**: Mic button gets a subtle pulsing outline (not filled red — that's reserved for active recording). Status text: "Listening for Titus..."
- **CAPTURING state**: Mic button turns red (same as current recording). Command input shows interim transcript preview. Status text: "Speak your command..."
- **IDLE state**: Normal appearance.

Add a small persistent indicator when Titus mode is enabled (e.g., small dot on mic button) so the user knows listening is active even when the UI looks idle.

### Haptic & Audio Feedback

When trigger word is detected:
- `navigator.vibrate?.(50)` — short haptic pulse
- Optional: play a subtle audio tone (like Siri's activation sound)

When command auto-sends:
- `navigator.vibrate?.(30)` — confirmation pulse
- If TTS enabled, speak "Sent" briefly

### Visibility Change Handling

iOS kills the mic when the app goes to background. Integrate with the existing `handleVisibilityChange`:

```javascript
// In handleVisibilityChange (connection.js)
if (!document.hidden && triggerState === TRIGGER_STATE.LISTENING) {
  // Tab came back — restart trigger listening
  setTimeout(() => {
    if (triggerShouldRestart) {
      try { recognition.start(); } catch (e) {}
    }
  }, 500);
}
```

## Acceptance Criteria

- [ ] Settings toggle enables/disables Titus mode
- [ ] When enabled, app listens for "Titus" trigger word while app is open
- [ ] Trigger detection works with variant spellings (tightest, tidus, etc.)
- [ ] After trigger detected, app captures spoken command with interim preview
- [ ] 3-second silence auto-sends the command
- [ ] After sending, mic goes fully idle (no listening)
- [ ] Saying "Titus" again starts a new command cycle
- [ ] Manual mic button still works (pauses trigger, resumes after)
- [ ] TTS playback pauses trigger listening (no feedback loop)
- [ ] Prompt voice responses take priority over trigger listening
- [ ] Works on iOS Safari (restart-loop approach, not continuous mode)
- [ ] Works on Chrome (continuous mode)
- [ ] Haptic feedback on trigger detection and command send
- [ ] Visual indicator shows when trigger listening is active
- [ ] Visibility change restarts listening when app returns to foreground
- [ ] Saying "cancel" or "stop" during capture cancels without sending

## Technical Considerations

- **Battery**: Continuous mic use drains battery. Acceptable for session-length use (app open). The toggle lets users control when it's active.
- **iOS Safari bugs**: `continuous = true` is unreliable on iOS (duplicate transcripts, stuck mic). Use `continuous = false` with auto-restart loop on iOS.
- **Single recognition instance**: Can't run trigger listening and manual voice input simultaneously. Priority system handles this.
- **Privacy**: Mic indicator (iOS orange dot, Chrome red icon) will be visible. Users must explicitly enable the feature.
- **No PWA support**: iOS PWAs don't support SpeechRecognition. Feature only works in Safari tab.

## Files Modified

- `public/js/state.js` — New trigger state variables and constants
- `public/js/ui.js` — Trigger mode functions, UI updates
- `public/js/init.js` — Modified `onresult` and `onend` handlers, settings toggle
- `public/js/connection.js` — Modified `handleVisibilityChange` for trigger restart
- `public/index.html` — Settings panel toggle for trigger mode
- `public/styles.css` — Trigger mode visual indicators

## References

- Existing voice input: `public/js/ui.js` (toggleVoiceInput, speak, speakThenListen)
- Existing speech init: `public/js/init.js` (initSpeechRecognition)
- Existing voice state: `public/js/state.js` (isRecording, recognition, synth)
- Web Speech API: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
- iOS Safari SpeechRecognition bugs: https://bugs.webkit.org/show_bug.cgi?id=225298
