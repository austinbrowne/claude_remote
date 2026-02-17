---
status: approved
issue: 25
tier: standard
date: 2026-02-17
---

# Fix Titus Trigger Word Voice Activation (#25)

## Problem

The trigger word ("Titus") feature has a complete implementation but fails to activate on app launch. Three root causes:

1. **No startup activation**: On first launch, `scenePhase` is already `.active`, so `.onChange` never fires and `restoreTriggerIfNeeded()` is never called.
2. **Aggressive crash-loop protection**: 10-second window disables trigger during normal multitasking.
3. **False positive variants**: "tightest" and "tight us" collide with common English words.

## Solution

### Fix 1: Startup Activation (ClaudeRemoteApp.swift)
Add `restoreTriggerIfNeeded()` to `.task` block.

### Fix 2: Tune Crash-Loop Protection (AppCoordinator.swift:1052)
Reduce window from 10s to 3s.

### Fix 3: Remove False Positive Variants (TriggerWordDetector.swift)
Remove "tightest" and "tight us" from `triggerVariants`.

### Fix 4: Server Fallback Feedback (SpeechService.swift)
Show toast when falling back to server-based recognition.

## Affected Files

| File | Change |
|------|--------|
| `ClaudeRemoteApp.swift` | Add `restoreTriggerIfNeeded()` to `.task` block |
| `AppCoordinator.swift:1052` | Reduce crash-loop window from 10s to 3s |
| `TriggerWordDetector.swift:8-10` | Remove "tightest" and "tight us" variants |
| `SpeechService.swift` | Add toast callback on server-based fallback |
| `TriggerWordDetectorTests.swift` | Update tests for removed variants |

## Acceptance Criteria

- [ ] Trigger word detection works end-to-end on fresh app launch
- [ ] Background → foreground within 5s does NOT disable trigger
- [ ] "tightest" and "tight us" no longer trigger false positives
- [ ] User sees toast when falling back to server-based recognition
- [ ] Cancel/stop commands work after activation
- [ ] Settings toggle correctly enables/disables the feature
- [ ] All existing tests pass after variant removal

## Risks

| Risk | Mitigation |
|------|------------|
| `restoreTriggerIfNeeded()` at startup could hang UI | Existing impl does audio work off-MainActor via `Task.detached` |
| 3s crash-loop window might miss some loops | Real crash loops restart in <1s; 3s is conservative |
