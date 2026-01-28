---
title: "feat: Subagent Visibility and Permissions on Mobile"
type: feat
date: 2026-01-26
priority: high
---

# Subagent Visibility and Permissions on Mobile

## Problem Statement

When Claude Code spawns subagents (via Task tool), the mobile app has zero visibility:
1. Can't see which subagents are running
2. Can't see what subagents are doing
3. Can't respond to subagent permission prompts (gets stuck)

## Research Findings

### Subagent Log Structure

Subagent logs are stored in a `subagents/` subdirectory:
```
~/.claude/projects/{projectHash}/{sessionId}/subagents/
├── agent-a343ba1.jsonl
├── agent-a08f0bb.jsonl
└── ...
```

### Message Format

Subagent messages have `isSidechain: true` and include:
- `agentId`: Short hex ID (e.g., "a343ba1")
- Tool use entries for Bash, Read, Write, etc.
- Permission requests just like main session

### Current Gap

`server.js:watchSession()` only watches the main session JSONL. The `logsDir` watcher (line 367) only detects new files in the logs directory, not in subdirectories like `subagents/`.

## Proposed Solution

### Phase 1: Server-side Subagent Watching

#### 1.1 Watch subagents directory

```javascript
// server.js - In watchSession(), after setting up main watcher

const subagentsDir = path.join(path.dirname(session.logFile), session.id, 'subagents');

// Watch for new subagent files
const subagentsDirWatcher = chokidar.watch(subagentsDir, {
  persistent: true,
  ignoreInitial: false,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
});

subagentsDirWatcher.on('add', (filePath) => {
  if (filePath.endsWith('.jsonl')) {
    const agentId = path.basename(filePath, '.jsonl').replace('agent-', '');
    watchSubagent(sessionId, agentId, filePath);
  }
});
```

#### 1.2 Create subagent watcher function

```javascript
function watchSubagent(sessionId, agentId, logFile) {
  let lastPosition = 0;

  const watcher = chokidar.watch(logFile, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  });

  watcher.on('change', async () => {
    const stats = await fsp.stat(logFile);
    if (stats.size > lastPosition) {
      const fd = await fsp.open(logFile, 'r');
      const buffer = Buffer.alloc(stats.size - lastPosition);
      await fd.read(buffer, 0, buffer.length, lastPosition);
      await fd.close();
      lastPosition = stats.size;

      const lines = buffer.toString('utf8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const parsed = parseLogEntry(entry);
          for (const msg of parsed) {
            broadcastToClients({
              type: 'subagent_output',
              sessionId,
              agentId,
              data: msg
            });
          }
        } catch (e) {}
      }
    }
  });

  // Store watcher for cleanup
  const sessionData = activeSessions.get(sessionId);
  if (sessionData) {
    sessionData.subagentWatchers = sessionData.subagentWatchers || new Map();
    sessionData.subagentWatchers.set(agentId, watcher);
  }
}
```

#### 1.3 Broadcast subagent start/stop

```javascript
// When subagent file is created
broadcastToClients({
  type: 'subagent_start',
  sessionId,
  agentId,
  timestamp: Date.now()
});

// When subagent stops writing (detect via timeout or final message)
broadcastToClients({
  type: 'subagent_stop',
  sessionId,
  agentId,
  timestamp: Date.now()
});
```

### Phase 2: Client-side UI Updates

#### 2.1 Track active subagents

```javascript
// State
let activeSubagents = new Map(); // agentId -> { status, lastActivity, description }

// Handle subagent messages
case 'subagent_start':
  activeSubagents.set(msg.agentId, {
    status: 'running',
    startTime: msg.timestamp,
    description: ''
  });
  updateSubagentIndicator();
  break;

case 'subagent_output':
  handleSubagentMessage(msg.agentId, msg.data);
  break;

case 'subagent_stop':
  activeSubagents.delete(msg.agentId);
  updateSubagentIndicator();
  break;
```

#### 2.2 Show subagent activity indicator

```html
<!-- Add to header or status bar -->
<div id="subagentIndicator" class="subagent-indicator hidden">
  <span class="subagent-count">0</span> subagents
  <div class="subagent-list"></div>
</div>
```

```javascript
function updateSubagentIndicator() {
  const indicator = document.getElementById('subagentIndicator');
  const count = activeSubagents.size;

  if (count === 0) {
    indicator.classList.add('hidden');
  } else {
    indicator.classList.remove('hidden');
    indicator.querySelector('.subagent-count').textContent = count;

    // Show list of active subagents
    const list = indicator.querySelector('.subagent-list');
    list.innerHTML = Array.from(activeSubagents.entries())
      .map(([id, data]) => `<div class="subagent-item">${id}: ${data.status}</div>`)
      .join('');
  }
}
```

#### 2.3 Handle subagent permission requests

```javascript
function handleSubagentMessage(agentId, data) {
  if (data.type === 'permission_request') {
    // Show permission card with subagent context
    showPromptCard({
      type: 'permission',
      text: `[Subagent ${agentId}] Allow ${data.tool}?`,
      command: data.tool === 'Bash' ? data.input?.command : `${data.tool}: ${data.input?.file_path}`,
      isDestructive: data.tool === 'Bash' && /\brm\b|\bdelete\b|\bdrop\b/.test((data.input?.command || '').toLowerCase()),
      subagentId: agentId  // Track which subagent needs the response
    });
  }

  // Also append to output with subagent prefix
  if (data.type === 'tool' || data.type === 'assistant') {
    appendSubagentMessage(agentId, data);
  }
}
```

#### 2.4 Route responses to correct subagent

```javascript
function respondToPrompt(response) {
  const subagentId = currentPrompt?.subagentId;

  if (subagentId) {
    // Send to subagent's session
    wsSend({
      action: 'inject',
      command: response,
      subagentId: subagentId  // Server routes to correct terminal/session
    });
  } else {
    // Normal main session inject
    wsSend({ action: 'inject', command: response });
  }
  // ...
}
```

### Phase 3: Visual Design

#### Subagent indicator in header
```
┌─────────────────────────────────────┐
│ Session: my-project    🔵 2 agents  │
│ ├─ a343ba1: Reading files...       │
│ └─ a08f0bb: ⏳ Waiting for input    │
└─────────────────────────────────────┘
```

#### Permission card with subagent context
```
┌─────────────────────────────────────┐
│ 🔐 Permission Request               │
│ [Subagent: research-agent]          │
│                                     │
│ Allow Bash?                         │
│ $ npm install axios                 │
│                                     │
│     [Yes]        [No]               │
└─────────────────────────────────────┘
```

## Implementation Checklist

### Server (server.js)

- [x] Add `subagentWatchers` Map to session data structure
- [x] Watch `{sessionDir}/subagents/` for new files
- [x] Create `watchSubagent(sessionId, agentId, logFile)` function
- [x] Broadcast `subagent_start` when new agent file detected
- [x] Broadcast `subagent_output` for each parsed message
- [x] Detect and broadcast `subagent_stop` (timeout or final message)
- [x] Clean up subagent watchers on session switch/disconnect
- [x] Handle `inject` action with `subagentId` for routing (N/A - Claude Code handles routing)

### Client (public/index.html)

- [x] Add `activeSubagents` Map state
- [x] Handle `subagent_start`, `subagent_output`, `subagent_stop` messages
- [x] Add subagent indicator UI component
- [x] Update `showPromptCard` to accept `subagentId`
- [x] Update `respondToPrompt` to route to correct subagent (N/A - Claude Code handles routing)
- [x] Add CSS for subagent indicator and list
- [x] Show subagent prefix on tool/assistant messages

## Files to Modify

| File | Changes |
|------|---------|
| `server.js:250-400` | Add subagent watching in `watchSession()` |
| `server.js:NEW` | Add `watchSubagent()` function |
| `server.js:700-730` | Handle `subagentId` in inject action |
| `public/index.html:1019` | Add `activeSubagents` state |
| `public/index.html:1400` | Handle subagent message types |
| `public/index.html:2127` | Update `showPromptCard()` |
| `public/index.html:2280` | Update `respondToPrompt()` |
| `public/index.html:CSS` | Add subagent indicator styles |

## Acceptance Criteria

- [x] Can see count of active subagents in header
- [x] Can see individual subagent status (running, waiting for input)
- [x] Subagent permission prompts appear on mobile
- [x] Can respond to subagent permissions from mobile
- [x] Subagent tool calls visible in output (with agent prefix) - Changed: now shown only in indicator badge, not in output stream
- [x] Subagent indicator disappears when all complete

## Testing

1. Start server, connect from mobile
2. Ask Claude to run a Task with subagents
3. Verify subagent indicator appears
4. Verify subagent permission prompts show on mobile
5. Respond to permission from mobile
6. Verify subagent completes and indicator updates
