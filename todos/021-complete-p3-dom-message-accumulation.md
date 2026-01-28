---
status: complete
priority: p3
issue_id: "021"
tags: [code-review, frontend, performance]
dependencies: []
---

# DOM Message Accumulation Without Limit

## Problem Statement

Messages accumulate indefinitely in the DOM output area. After 1000+ messages, DOM becomes sluggish and memory usage grows unbounded.

**Why it matters:** Long sessions become unusably slow.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html:944-976`

```javascript
function appendMessage(data, scroll = true) {
  // No limit check - messages accumulate forever
  outputArea.appendChild(msg);
}
```

## Proposed Solutions

### Option A: Add Message Limit (Recommended)
**Effort:** Small

```javascript
const MAX_MESSAGES = 500;

function appendMessage(data, scroll = true) {
  while (outputArea.children.length >= MAX_MESSAGES) {
    outputArea.removeChild(outputArea.firstChild);
  }
  // ... rest of function
}
```

## Acceptance Criteria

- [ ] Maximum 500 messages retained in DOM
- [ ] Oldest messages removed automatically
- [ ] Consistent performance in long sessions

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Unbounded DOM growth causes problems |
