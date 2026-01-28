---
status: pending
priority: p2
issue_id: "039"
tags:
  - architecture
  - code-review
  - refactoring
dependencies: []
---

# Monolithic server.js Needs Refactoring

## Problem Statement

`server.js` is 1247 lines and handles session discovery, file watching, WebSocket handling, AppleScript injection, and rate limiting all in one file. This makes it hard to test, maintain, and extend.

**Why it matters**: Single file doing too much violates separation of concerns.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js`

**Current responsibilities:**
- Express server setup
- WebSocket server
- Session discovery and management
- File watching (main session + subagents)
- Log parsing
- Command injection (AppleScript)
- Rate limiting
- Health endpoint

**Discovered by:** architecture-strategist agent

## Proposed Solutions

### Option A: Extract modules by domain (Recommended)
```
server/
├── index.js          # Express + WS setup, main entry
├── sessions.js       # discoverSessions, watchSession, watchSubagent
├── parser.js         # parseLogEntry, getSessionStatus
├── injection.js      # injectCommand, injectCommandDirect
├── rate-limiter.js   # RateLimiter class, globalRateLimiter
└── websocket.js      # WebSocket handlers, broadcastToClients
```
- **Pros:** Clear separation, testable modules
- **Cons:** Larger refactor
- **Effort:** Medium
- **Risk:** Medium

### Option B: Extract just the largest concerns
- Move `parseLogEntry` to `parser.js`
- Move `injectCommand*` to `injection.js`
- Keep rest in server.js
- **Pros:** Smaller change
- **Cons:** Still somewhat monolithic
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] server.js under 500 lines
- [ ] Each module has single responsibility
- [ ] All existing tests pass
- [ ] No behavior changes

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-27 | Created | Found during architecture review |
