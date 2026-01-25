---
status: pending
priority: p3
issue_id: "025"
tags: [code-review, frontend, race-condition]
dependencies: []
---

# TTS Speaking Highlight Not Cleaned on Cancel

## Problem Statement

When TTS is cancelled, the `onend` callback may not fire (browser-dependent). The previous message remains with `.speaking` class forever, glowing blue indefinitely.

**Why it matters:** Visual artifact persists in UI.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html:1055-1065`

```javascript
synth.cancel();  // May not trigger onend

utterance.onend = () => {
  if (lastMsg) lastMsg.classList.remove('speaking');
};
```

## Proposed Solutions

### Option A: Track and Clean Explicitly (Recommended)
**Effort:** Small

```javascript
let speakingMessageElement = null;

function speak(text) {
  // Clear previous highlight explicitly
  if (speakingMessageElement) {
    speakingMessageElement.classList.remove('speaking');
    speakingMessageElement = null;
  }

  synth.cancel();
  // ... rest
}
```

## Acceptance Criteria

- [ ] Previous highlight always cleared before new speech
- [ ] No orphaned .speaking classes

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Browser APIs have inconsistent cleanup |
