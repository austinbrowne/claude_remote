---
status: pending
priority: p2
issue_id: "032"
tags:
  - security
  - code-review
dependencies: []
---

# Token Comparison Vulnerable to Timing Attack

## Problem Statement

The authentication token comparison uses standard string equality (`!==`) which is not constant-time. This theoretically allows timing-based attacks to guess the token character by character.

**Why it matters**: While exploitation requires precise timing measurements, this is a known vulnerability pattern that should be fixed for defense in depth.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js` lines 504-508, 735

```javascript
if (token !== AUTH_TOKEN) {
  ws.close(4001, 'Unauthorized');
  return;
}
```

Standard string comparison exits early on first mismatch, leaking timing information about how many characters matched.

## Proposed Solutions

### Option A: Use crypto.timingSafeEqual (Recommended)
```javascript
const crypto = require('crypto');

function secureCompare(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

if (!secureCompare(token, AUTH_TOKEN)) {
  ws.close(4001, 'Unauthorized');
  return;
}
```
- **Pros**: Cryptographically secure, built-in solution
- **Cons**: Slightly more verbose
- **Effort**: Low
- **Risk**: None

### Option B: Accept current risk
- Document as known limitation
- Timing attacks over network are difficult
- **Pros**: No code change
- **Cons**: Leaves vulnerability
- **Effort**: None
- **Risk**: Low (but non-zero)

## Recommended Action

Option A - Use crypto.timingSafeEqual for token comparison.

## Technical Details

**Affected files:**
- `server.js:504-508` - WebSocket auth
- `server.js:735` - HTTP health endpoint auth

## Acceptance Criteria

- [ ] Token comparison uses crypto.timingSafeEqual
- [ ] Both WebSocket and HTTP auth updated
- [ ] Authentication still works correctly

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-26 | Created | Identified during security review |

## Resources

- https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b
- Security sentinel agent finding
