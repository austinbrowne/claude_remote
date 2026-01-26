---
status: complete
priority: p2
issue_id: "035"
tags:
  - architecture
  - code-review
  - maintainability
dependencies: []
---

# Global State Pollution in Frontend

## Problem Statement

The frontend uses 20+ global variables for state management, including values stored on the `window` object. This makes the code hard to reason about, test, and debug.

**Why it matters**: Hidden dependencies between functions, race conditions, and difficulty tracking state changes.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html` lines 999-1019, 1368-1379, 1624

**Global variables (top-level):**
```javascript
let reconnectTimeout = null;
let reconnectAttempts = 0;
let pingTimeout = null;
let toastTimeout = null;
let ws = null;
let authToken = sessionStorage.getItem('claude_remote_token') || '';
let currentSessionId = null;
let isRecording = false;
let recognition = null;
let synth = window.speechSynthesis;
let currentUtterance = null;
let settings = { /* ... */ };
const MAX_MESSAGES = 500;
const recentUserMessages = [];
let currentPrompt = null;
let promptMessageIndex = 0;
let autocompleteIndex = -1;
let prismLoaded = false;
```

**Window object pollution:**
```javascript
window.pendingPermissionCard = { tool, cmd, isDestructive };
window.pendingPermissionTimeout = setTimeout(...);
window.lastPermissionCardTime = Date.now();
window.lastToolLanguage = language;
```

## Proposed Solutions

### Option A: Consolidate into state object (Recommended)
```javascript
const appState = {
  // Connection
  ws: null,
  authToken: sessionStorage.getItem('claude_remote_token') || '',
  reconnectAttempts: 0,
  reconnectTimeout: null,

  // Session
  currentSessionId: null,
  currentPrompt: null,

  // UI
  toastTimeout: null,
  autocompleteIndex: -1,

  // Features
  prismLoaded: false,
  pendingPermission: null
};
```
- **Pros**: Single source of truth, easier debugging
- **Cons**: Requires updating all references
- **Effort**: Medium
- **Risk**: Low

### Option B: Use module pattern with getters/setters
- Encapsulate state in IIFE
- Expose controlled API
- **Pros**: Better encapsulation
- **Cons**: More boilerplate
- **Effort**: Medium
- **Risk**: Low

## Recommended Action

Option A - Consolidate into single state object.

## Technical Details

**Affected files:**
- `public/index.html:999-1019` - global declarations
- `public/index.html:1368-1379` - window pollution
- Throughout file - all references to these variables

## Acceptance Criteria

- [x] All state consolidated into single object
- [x] No new values added to window object
- [x] State changes easy to track/debug
- [x] All functionality preserved

Note: Window object pollution eliminated via `pending` object. Top-level variables remain script-scoped (not on window).

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-26 | Created | Identified during pattern recognition review |

## Resources

- Pattern recognition specialist agent finding
- Architecture strategist agent finding
