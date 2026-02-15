---
title: "Voice Auto-Send and Continuous Voice Loop"
date: 2026-02-08
status: decided
chosen_approach: "Approach 2 (Continuous Voice Loop) — built incrementally"
tags: [voice, auto-send, auto-mode, continuous-loop, speech, trigger-word]
related_solutions:
  - docs/solutions/concurrency-issues/trigger-word-phase5-audio-arbitration.md
  - docs/solutions/concurrency-issues/voice-io-phase4-review-fixes.md
feeds_into: "docs/plans/2026-02-08-voice-auto-send-continuous-loop-plan.md"
---

# Voice Auto-Send and Continuous Voice Loop

## Problem Space

Voice is the key feature of the app, but the current UX has friction:
1. Manual mic dictation requires a tap to send — transcript fills text field but user must hit send
2. Prompt responses require manual taps — auto-mode exists but is a separate toggle, disconnected from trigger word mode
3. Three separate modes (manual mic, trigger word, auto-mode) that don't compose into a seamless hands-free experience

**Goal:** A voice-driven loop: dictate → auto-send → Claude works → prompt appears → voice responds → loop.

## Approaches Considered

### Approach 1: Silence Auto-Send + Auto-Mode Follows Trigger (Incremental)
- Manual mic gets silence timer (3s → auto-send)
- Trigger mode implicitly enables auto-mode
- Low risk, reuses existing patterns
- **Con:** Still two mental models, not truly hands-free

### Approach 2: Continuous Voice Loop (Conversational) ← CHOSEN
- After voice input sent, stay listening — don't stop
- Prompts auto-speak and listen for voice match
- "Stop" / "done" exits the loop
- True hands-free experience
- **Con:** Complex state, battery, false-send risk

### Approach 3: Voice-Activated Prompt Cards (Prompt-Focused)
- Per-prompt mic button for one-shot voice response
- Explicit user control, visual confirmation
- **Con:** Still requires a tap per prompt unless trigger is on

## Decision

**Approach 2, built incrementally:**
1. Phase 1: Silence auto-send on manual mic + trigger enables auto-mode (Approach 1 foundation)
2. Phase 2: Continuous voice loop — after send, keep listening; stop command exits

This gets immediate value from Phase 1 and layers on the loop behavior without big-bang risk.
