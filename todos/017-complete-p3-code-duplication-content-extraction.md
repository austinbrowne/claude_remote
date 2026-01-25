---
status: pending
priority: p3
issue_id: "017"
tags: [code-review, quality, refactoring]
dependencies: []
---

# Duplicate Content Extraction Logic

## Problem Statement

The code for extracting text content from log entries is duplicated identically for user and assistant message types.

**Why it matters:** DRY violation, maintenance burden.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js:195-206, 218-229`

Same logic repeated twice for assistant and user messages.

## Proposed Solutions

### Option A: Extract Helper Function (Recommended)
**Effort:** Small

```javascript
function extractContent(entry) {
  if (typeof entry.content === 'string') return entry.content;
  if (Array.isArray(entry.content)) {
    return entry.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return entry.message || '';
}
```

## Acceptance Criteria

- [ ] Single extractContent() function
- [ ] Used in both user and assistant parsing

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Identified during pattern analysis |
