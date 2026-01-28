---
status: complete
priority: p3
issue_id: "026"
tags: [code-review, frontend, ux]
dependencies: []
---

# No Double-Click Protection on Send

## Problem Statement

A fast double-click on the send button or rapid Enter key presses can submit the same command twice. The input is cleared after `ws.send`, but in the brief moment between clicks the command is still available.

**Why it matters:** Duplicate commands sent to Claude.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html:995-1011`

```javascript
function sendCommand() {
  // No guard against rapid submission
  ws.send(...);
  input.value = '';  // Too late to prevent second click
}
```

## Proposed Solutions

### Option A: Disable Button During Send (Recommended)
**Effort:** Small

```javascript
function sendCommand() {
  const sendBtn = document.getElementById('sendBtn');
  if (sendBtn.disabled) return;

  sendBtn.disabled = true;
  // ... send logic
  setTimeout(() => sendBtn.disabled = false, 300);
}
```

## Acceptance Criteria

- [ ] Send button disabled briefly after send
- [ ] No duplicate commands on double-click

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Always debounce user actions |
