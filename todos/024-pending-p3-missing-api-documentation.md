---
status: pending
priority: p3
issue_id: "024"
tags: [code-review, documentation, agent-native]
dependencies: []
---

# WebSocket API Not Documented

## Problem Statement

The WebSocket protocol is completely undocumented. Developers or agents building integrations have no reference for available actions, message types, or expected responses.

**Why it matters:** Integration development requires reading source code.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/README.md` (missing section)

**Undocumented:**
- Connection URL format
- All action types (watch_session, inject, escape, etc.)
- All response types (sessions, watching, claude_output, etc.)
- Error handling

## Proposed Solutions

### Option A: Add API Documentation Section (Recommended)
**Effort:** Medium

Add to README:
```markdown
## WebSocket API

### Connection
```
ws://host:3456?token=YOUR_TOKEN
```

### Actions
| Action | Parameters | Response |
|--------|------------|----------|
| watch_session | sessionId | watching |
| inject | command | inject_result |
...
```

## Acceptance Criteria

- [ ] README documents all WebSocket actions
- [ ] Response formats documented
- [ ] Error codes listed

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | APIs need documentation |
