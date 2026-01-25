---
status: pending
priority: p2
issue_id: "015"
tags: [code-review, architecture, agent-native]
dependencies: []
---

# Error Messages Are Not Machine-Parseable

## Problem Statement

Error messages are human-readable strings, not structured codes. Agent code must pattern-match on strings like "Session not found or no log file" rather than checking an error code.

**Why it matters:** Agents cannot reliably handle specific error conditions.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js:354-357`

```javascript
ws.send(JSON.stringify({
  type: 'error',
  message: 'Session not found or no log file'
}));
```

**Evidence:**
- Errors have `message` but no `code`
- Different error types indistinguishable
- No error details or context

**Discovered by:** agent-native-reviewer agent

## Proposed Solutions

### Option A: Add Structured Error Codes (Recommended)
**Pros:** Programmatic error handling
**Cons:** Must define error codes
**Effort:** Small
**Risk:** Low

```javascript
const ErrorCodes = {
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  INVALID_SESSION: 'INVALID_SESSION',
  INJECT_FAILED: 'INJECT_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED'
};

function sendError(ws, code, message, details = {}) {
  ws.send(JSON.stringify({
    type: 'error',
    code: code,
    message: message,
    details: details
  }));
}

// Usage
sendError(ws, ErrorCodes.SESSION_NOT_FOUND, 'Session not found', { sessionId: msg.sessionId });
```

## Acceptance Criteria

- [ ] All errors include machine-readable `code` field
- [ ] Error codes documented in README
- [ ] Details object provides context

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Machine clients need structured errors |
