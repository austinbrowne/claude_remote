---
title: "Server Modularization with Factory Pattern and Dependency Injection"
category: integration-issues
subcategory: architecture
tags:
  - modularization
  - refactoring
  - dependency-injection
  - factory-pattern
  - express
  - websocket
components:
  - server.js
  - lib/watcher.js
  - lib/log-parser.js
  - lib/file-api.js
  - lib/command-injection.js
  - lib/session-discovery.js
  - lib/commands.js
  - lib/utils.js
symptoms:
  - monolith
  - difficult-navigation
  - implicit-shared-state
severity: medium
date: 2026-02-18
---

# Server Modularization with Factory Pattern and Dependency Injection

## Problem

server.js was 3492 lines — a monolithic Express+WebSocket server with session discovery, file watching, subagent coordination, log parsing, command injection, REST API, and WebSocket handling. Finding anything required scrolling through 3500 lines, and implicit shared state (activeSessions, clients Maps) made changes risky.

## Solution

Extract 7 focused modules under `lib/`, with server.js reduced to ~1260 lines of orchestration. Key design decisions:

### 1. Dependency Injection via `deps` Object (No Module-to-Module Imports)

```javascript
// server.js assembles deps once
const { watchSession, unwatchSession } = createWatcher({
  activeSessions, broadcastToClients, parseLogEntry,
  detectMilestone, parserState, getSessionStatus,
  loadAllowedTools, discoverSessions,
  onNewSessionAfterClear: handleNewSessionAfterClear
});
```

Modules receive `deps` and destructure what they need. No module requires another module — only server.js requires all of them. This eliminates circular dependencies.

### 2. Factory Pattern for Stateful Modules

Modules with internal mutable state use factory functions:

```javascript
// lib/watcher.js — closure captures deps + internal state
function createWatcher(deps) {
  const subagentToolThrottles = new Map(); // module-internal
  function watchSession(sessionId, logFilePath) { ... }
  function unwatchSession(sessionId) { ... }
  return { watchSession, unwatchSession };
}
```

### 3. Express Router Factory for REST APIs

```javascript
// lib/file-api.js
function createFileApiRouter({ activeSessions, discoverSessions, secureCompare, AUTH_TOKEN }) {
  const router = express.Router();
  // mount routes...
  return router;
}
```

### 4. Parser State Factory for Cross-Entry Correlation

```javascript
// lib/log-parser.js
function createParserState() {
  return {
    pendingSubagentDescriptions: new Map(),
    pendingTaskIds: new Map(),
    taskIdMap: new Map()
  };
}
```

### 5. Pure Utility Modules (No State)

```javascript
// lib/utils.js — stateless, directly exported
module.exports = { stripAnsi, formatMcpToolName, sanitizeMcpInput, ... };
```

## Extraction Order (Lowest Risk First)

1. `lib/utils.js` (90 lines) — pure utilities, zero shared state
2. `lib/commands.js` (156 lines) — slash command discovery
3. `lib/command-injection.js` (295 lines) — AppleScript/iTerm interaction
4. `lib/file-api.js` (232 lines) — Express Router for file API
5. `lib/session-discovery.js` (338 lines) — process scanning
6. `lib/log-parser.js` (430 lines) — log parsing + milestone detection
7. `lib/watcher.js` (837 lines) — session + subagent file watching (heaviest deps)

## Key Insight

**Test after every step.** Running all tests + server restart after each module extraction catches issues immediately. The orphaned function body bug (parseLogEntry signature removed but body left behind) was caught this way.

## Gotchas

- **Initialization ordering matters**: `createWatcher(deps)` must be called AFTER `broadcastToClients` is defined. Factory pattern defers watcher creation to the right point in server.js.
- **Callback pattern for cross-module calls**: The watcher needed to call `handleNewSessionAfterClear` (defined in server.js). Solved via `deps.onNewSessionAfterClear` callback.
- **Unused imports accumulate**: After extraction, `chokidar`, `os`, and `parseTaskListResult` were no longer used in server.js. Clean up removed imports.
- **Test migration**: Tests importing replicated functions should be updated to import from the new modules. Tests that replicate inline helpers (compaction, team-awareness) can stay as-is.

## Results

- server.js: 3492 -> 1260 lines (64% reduction)
- 7 focused modules with clear responsibilities
- 272 tests passing (86 new tests added during review fixes)
- Zero behavioral changes — pure structural refactoring
