---
status: complete
priority: p1
issue_id: "003"
tags: [code-review, security, authentication, client]
dependencies: []
---

# Authentication Token Stored in localStorage

## Problem Statement

The auth token is persisted in browser localStorage, which is vulnerable to XSS attacks, browser extension access, physical device access, and shared device scenarios. Any XSS vulnerability would allow token theft and full remote access to the user's machine.

**Why it matters:** localStorage is accessible to any JavaScript running on the same origin. A single XSS vulnerability grants attackers full machine access.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html:681, 799`

```javascript
// Line 681
let authToken = localStorage.getItem('claude_remote_token') || '';

// Line 799
localStorage.setItem('claude_remote_token', authToken);
```

**Evidence:**
- Token persists across browser sessions
- No expiration mechanism
- No encryption of stored token
- Vulnerable to XSS token theft

**Discovered by:** security-sentinel agent

## Proposed Solutions

### Option A: Use sessionStorage Instead (Recommended)
**Pros:** Token cleared when tab closes, limits exposure window
**Cons:** User must re-enter token on each visit
**Effort:** Small
**Risk:** Low

```javascript
// Replace localStorage with sessionStorage
let authToken = sessionStorage.getItem('claude_remote_token') || '';
sessionStorage.setItem('claude_remote_token', authToken);
```

### Option B: Implement Proper Session Management
**Pros:** Most secure, supports token rotation and expiration
**Cons:** Requires server-side changes, more complex
**Effort:** Large
**Risk:** Low

Exchange long-lived token for short-lived session token with httpOnly cookie.

### Option C: Add Token Encryption
**Pros:** Adds layer of protection
**Cons:** Key management problem, still vulnerable to XSS reading decrypted value
**Effort:** Medium
**Risk:** Medium (false sense of security)

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected files:** `public/index.html`
**Components:** Client authentication
**Database changes:** None

## Acceptance Criteria

- [ ] Token not persisted in localStorage
- [ ] User prompted for token on new sessions (or sessionStorage used)
- [ ] Clear guidance on token security in UI

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | localStorage is convenient but insecure for auth tokens |

## Resources

- OWASP: A07 Identification and Authentication Failures
