---
status: complete
priority: p2
issue_id: "012"
tags: [code-review, security, information-disclosure]
dependencies: []
---

# Health Endpoint Information Disclosure

## Problem Statement

The `/health` endpoint is unauthenticated and reveals session count, client count, and server timestamp. This aids reconnaissance and confirms the service is running.

**Why it matters:** Attackers can fingerprint and monitor the service without authentication.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js:492-499`

```javascript
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sessions: discoverSessions().length,
    clients: clients.size,
    timestamp: new Date().toISOString()
  });
});
```

**Evidence:**
- No authentication required
- Reveals active session count
- Reveals connected client count
- Aids timing attacks via timestamp

**Discovered by:** security-sentinel agent

## Proposed Solutions

### Option A: Minimal Unauthenticated Response (Recommended)
**Pros:** Maintains health check utility, reduces disclosure
**Cons:** Less info for debugging
**Effort:** Small
**Risk:** Low

```javascript
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Detailed health requires auth
app.get('/health/detailed', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({
    status: 'ok',
    sessions: discoverSessions().length,
    clients: clients.size
  });
});
```

## Acceptance Criteria

- [ ] `/health` returns only `{ "status": "ok" }`
- [ ] Detailed info requires authentication
- [ ] No timestamp leakage

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Minimize unauthenticated endpoints |
