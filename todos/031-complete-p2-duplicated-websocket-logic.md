---
status: complete
priority: p2
issue_id: "031"
tags:
  - code-quality
  - code-review
  - duplication
dependencies: []
---

# Duplicated WebSocket Connection Logic

## Problem Statement

The `connect()` and `reconnect()` functions in `index.html` contain nearly identical WebSocket setup code (~40 lines duplicated). This violates DRY and creates maintenance burden.

**Why it matters**: Changes to connection handling must be made in two places, risking inconsistency and bugs.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html`
- `connect()`: lines 1143-1202
- `reconnect()`: lines 1267-1332

**Duplicated logic:**
- `ws.onopen` handler with status dot updates, reconnect counter reset
- `ws.onclose` handler with exponential backoff calculation
- `ws.onerror` handler
- `ws.onmessage` handler
- Session re-watching on reconnect

Both functions do essentially the same thing with minor variations.

## Proposed Solutions

### Option A: Extract shared function (Recommended)
```javascript
function createWebSocket(wsUrl, onConnected) {
  const ws = new WebSocket(wsUrl);
  setupWebSocketHandlers(ws, onConnected);
  return ws;
}

function setupWebSocketHandlers(ws, onConnected) {
  ws.onopen = () => { /* shared logic */ };
  ws.onclose = handleWsClose;
  ws.onerror = handleWsError;
  ws.onmessage = handleWsMessage;
}
```
- **Pros**: Single source of truth, easier maintenance
- **Cons**: Requires refactoring
- **Effort**: Medium
- **Risk**: Low

### Option B: Merge into single connect function
- Have `connect()` handle both initial and reconnection
- Use flag to differentiate behavior
- **Pros**: Simpler API
- **Cons**: Function becomes more complex
- **Effort**: Low
- **Risk**: Low

## Recommended Action

Option A - Extract shared WebSocket setup function.

## Technical Details

**Affected files:**
- `public/index.html:1143-1202` - connect()
- `public/index.html:1267-1332` - reconnect()

**Estimated LOC reduction:** ~20-30 lines

## Acceptance Criteria

- [ ] Single function handles WebSocket setup
- [ ] connect() and reconnect() reuse shared logic
- [ ] Connection and reconnection still work correctly
- [ ] Exponential backoff preserved
- [ ] Session re-watching works on reconnect

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-26 | Created | Identified during simplicity and pattern reviews |

## Resources

- Code simplicity reviewer agent finding
- Pattern recognition specialist agent finding
