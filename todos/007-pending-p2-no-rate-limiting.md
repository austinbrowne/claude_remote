---
status: pending
priority: p2
issue_id: "007"
tags: [code-review, security, dos-prevention]
dependencies: []
---

# No Rate Limiting on Authentication or Commands

## Problem Statement

No rate limiting on WebSocket connections, authentication attempts, or command injection. An attacker can brute force tokens or flood the terminal with commands without restriction.

**Why it matters:** Enables brute force attacks on tokens and potential terminal DoS.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js:280-287, 380-385`

**Evidence:**
- Unlimited connection attempts per IP
- No exponential backoff after failed auth
- No command rate limiting
- No account lockout mechanism

**Discovered by:** security-sentinel, architecture-strategist agents

## Proposed Solutions

### Option A: Add express-rate-limit Middleware (Recommended)
**Pros:** Well-tested, easy to implement
**Cons:** Adds dependency
**Effort:** Small
**Risk:** Low

```javascript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  message: 'Too many requests'
});

app.use(limiter);
```

### Option B: WebSocket-Level Rate Limiting
**Pros:** More granular control
**Cons:** Must implement manually
**Effort:** Medium
**Risk:** Low

## Acceptance Criteria

- [ ] Max 10 connection attempts per IP per minute
- [ ] Max 30 commands per minute per connection
- [ ] Failed auth attempts trigger progressive delays

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Rate limiting is essential for exposed services |
