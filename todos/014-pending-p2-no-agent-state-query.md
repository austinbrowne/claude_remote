---
status: pending
priority: p2
issue_id: "014"
tags: [code-review, architecture, agent-native]
dependencies: []
---

# No API for Querying Current State

## Problem Statement

Agents cannot determine current state programmatically. After reconnecting, an agent cannot know: what session it was watching, connection status, or pending operations. This violates agent-native architecture principles.

**Why it matters:** Agents must maintain their own state externally, breaking context parity.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js` (missing feature)

**Evidence:**
- No `get_state` action in WebSocket handler
- Session watching state only visible to specific client
- Settings stored but not retrievable
- No way to list what sessions client is watching

**Discovered by:** agent-native-reviewer agent

## Proposed Solutions

### Option A: Add get_state Action (Recommended)
**Pros:** Complete state visibility for agents
**Cons:** None
**Effort:** Small
**Risk:** Low

```javascript
case 'get_state':
  ws.send(JSON.stringify({
    type: 'state',
    clientId: clientData.id,
    watchingSessions: Array.from(clientData.watchingSessions),
    settings: clientData.settings,
    connectedAt: clientData.connectedAt
  }));
  break;
```

## Acceptance Criteria

- [ ] Agents can query current state via `get_state` action
- [ ] Response includes watching sessions, settings, client ID
- [ ] State queryable immediately after reconnection

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Agent-native requires state introspection |
