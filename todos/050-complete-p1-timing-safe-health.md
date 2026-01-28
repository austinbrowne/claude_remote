---
status: complete
priority: p1
issue_id: "050"
tags:
  - security
  - code-review
dependencies: []
---

# Timing-Safe Comparison Missing on /health/detailed

## Problem Statement

The `/health/detailed` endpoint uses direct string comparison (`!==`) instead of `secureCompare()`, making it vulnerable to timing attacks.

**Why it matters**: An attacker could potentially determine the AUTH_TOKEN character-by-character through timing analysis.

## Findings

**Location:** `server.js:1444`

**Current code:**
```javascript
app.get('/health/detailed', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== AUTH_TOKEN) {  // NOT timing-safe!
```

**Note:** The WebSocket auth on line 1060 correctly uses `secureCompare()`.

## Proposed Solutions

### Option A: Use secureCompare (Recommended)
```javascript
if (!secureCompare(token, AUTH_TOKEN)) {
  return res.status(401).json({ error: 'Unauthorized' });
}
```
- **Pros:** Trivial fix, uses existing helper
- **Cons:** None
- **Effort:** Trivial
- **Risk:** None

## Acceptance Criteria

- [ ] `/health/detailed` uses `secureCompare()` for token comparison
- [ ] All auth checks in codebase use timing-safe comparison

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-27 | Created | Security review finding |
