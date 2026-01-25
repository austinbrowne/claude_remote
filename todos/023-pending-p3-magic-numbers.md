---
status: pending
priority: p3
issue_id: "023"
tags: [code-review, quality, maintainability]
dependencies: []
---

# Magic Numbers Throughout Codebase

## Problem Statement

Hard-coded numbers without explanation: polling interval 100ms, history limit 100, reconnect delay 3000ms, truncation length 300, toast duration 2500ms, etc.

**Why it matters:** Unclear intent, harder to tune behavior.

## Findings

**Locations:**
- `server.js:111` - `interval: 100`
- `server.js:414` - `lines.slice(-100)`
- `index.html:820` - `setTimeout(..., 3000)`
- `index.html:960` - `result.length > 300`
- `index.html:1163` - `setTimeout(..., 2500)`

## Proposed Solutions

### Option A: Extract Named Constants (Recommended)
**Effort:** Small

```javascript
// server.js
const POLLING_INTERVAL_MS = 100;
const HISTORY_LINE_LIMIT = 100;

// client
const RECONNECT_DELAY_MS = 3000;
const TOAST_DURATION_MS = 2500;
const TOOL_RESULT_TRUNCATE_LENGTH = 300;
```

## Acceptance Criteria

- [ ] All magic numbers replaced with named constants
- [ ] Constants grouped at top of file

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Name your constants |
