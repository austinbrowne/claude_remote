---
status: pending
priority: p3
issue_id: "040"
tags:
  - architecture
  - code-review
  - api-design
dependencies: []
---

# WebSocket Messages Lack Protocol Version

## Problem Statement

WebSocket messages have no version field, making it impossible to evolve the protocol without breaking clients. Adding new message types or changing existing ones risks silent failures.

**Why it matters**: Protocol evolution without versioning leads to incompatibilities.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js`, `/Users/austin/Git_Repos/claude_remote/public/index.html`

**Current message format:**
```javascript
{ type: 'session_output', sessionId: '...', data: {...} }
```

**No version field** - client has no way to know if server message format changed.

**Discovered by:** architecture-strategist agent

## Proposed Solutions

### Option A: Add protocol version to all messages (Recommended)
```javascript
{
  v: 1,  // Protocol version
  type: 'session_output',
  sessionId: '...',
  data: {...}
}
```
- **Pros:** Future-proof, clients can handle version differences
- **Cons:** Small payload increase
- **Effort:** Small
- **Risk:** Low

### Option B: Version negotiation on connect
- Client sends supported versions
- Server picks highest compatible
- **Pros:** More flexible
- **Cons:** More complex
- **Effort:** Medium
- **Risk:** Low

## Acceptance Criteria

- [ ] All WebSocket messages include version field
- [ ] Client validates version on incoming messages
- [ ] Unknown versions logged but don't crash

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-27 | Created | Found during architecture review |
