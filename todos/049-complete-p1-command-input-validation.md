---
status: complete
priority: p1
issue_id: "049"
tags:
  - security
  - code-review
dependencies: []
---

# Missing Input Validation on Inject Command

## Problem Statement

The `msg.command` from WebSocket clients is passed directly to `injectCommandToTty()` without any validation of length, content, or character encoding.

**Why it matters**:
- Memory exhaustion with very large commands
- Potential injection attacks with special characters
- Clipboard pollution in legacy mode

## Findings

**Location:** `server.js:1132-1162`

**Current code:**
```javascript
case 'inject':
  discoverSessions().then(currentSessions => {
    // No validation of msg.command
    injectCommandToTty(msg.command, injectTty)...
```

**Missing validations:**
- Type checking (should be string)
- Length limits (could be megabytes)
- Character validation (control characters, null bytes)

## Proposed Solutions

### Option A: Add Validation Block (Recommended)
```javascript
case 'inject':
  if (typeof msg.command !== 'string' || msg.command.length === 0) {
    ws.send(JSON.stringify({ type: 'inject_result', success: false, error: 'Command required' }));
    break;
  }
  if (msg.command.length > 10000) {
    ws.send(JSON.stringify({ type: 'inject_result', success: false, error: 'Command too long (max 10000)' }));
    break;
  }
  // Continue with existing logic...
```
- **Pros:** Simple, effective
- **Cons:** Hardcoded limit
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] Type validation (must be string)
- [ ] Length limit enforced (10000 chars reasonable)
- [ ] Clear error messages returned to client
- [ ] Rate limiting still applies

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-27 | Created | Security review finding |
