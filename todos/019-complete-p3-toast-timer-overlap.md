---
status: pending
priority: p3
issue_id: "019"
tags: [code-review, frontend, ux]
dependencies: []
---

# Toast Timer Overlap on Rapid Calls

## Problem Statement

Rapid toast calls have overlapping hide timers. The first timer fires and hides the second toast prematurely, causing messages to flash briefly and vanish.

**Why it matters:** Confusing UX - toasts disappear unexpectedly.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html:1159-1164`

```javascript
function showToast(message, type = '') {
  // No timer tracking
  setTimeout(() => toast.className = 'toast', 2500);
}
```

## Proposed Solutions

### Option A: Track and Cancel Timer (Recommended)
**Effort:** Small

```javascript
let toastTimeout = null;

function showToast(message, type = '') {
  if (toastTimeout) clearTimeout(toastTimeout);
  // ...
  toastTimeout = setTimeout(() => {
    toast.className = 'toast';
    toastTimeout = null;
  }, 2500);
}
```

## Acceptance Criteria

- [ ] New toast cancels previous timer
- [ ] Full 2.5s display for each toast

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Always track timers |
