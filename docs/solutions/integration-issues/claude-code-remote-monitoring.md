---
title: "Claude Code Remote Monitoring"
category: integration-issues
subcategory: real-time-sync
tags:
  - websocket
  - file-watching
  - chokidar
  - session-management
  - jsonl
  - iterm
  - applescript
  - mobile
components:
  - server.js:discoverSessions
  - server.js:watchSession
  - server.js:parseLogEntry
  - server.js:getSessionStatus
  - public/index.html:handleMessage
  - public/index.html:renderHistory
  - public/index.html:showPromptCard
symptoms:
  - streaming-stops-after-resume
  - permission-cards-for-auto-approved
  - prompts-missing-after-background
  - tool-result-not-dismissing-cards
root_causes:
  - stale-sessions-index-json
  - no-delay-before-permission-ui
  - history-not-checking-pending-prompts
  - empty-output-not-emitting-tool-result
severity: high
date_solved: 2026-01-25
---

# Claude Code Remote Monitoring

Mobile companion app for monitoring and controlling Claude Code sessions running in iTerm.

## Overview

Claude Remote provides real-time streaming of Claude Code sessions to mobile devices via WebSocket, enabling:
- Live output streaming from any Claude Code session
- Remote command injection via AppleScript
- Permission granting for Bash/Write/Edit tools
- Voice input/output (TTS)
- Structured prompt responses (AskUserQuestion)

## Architecture

```
iTerm (Claude Code process)
    ↓ writes to
~/.claude/projects/<hash>/<sessionId>.jsonl
    ↓ watched by
chokidar file watcher (server.js)
    ↓ parsed by
parseLogEntry()
    ↓ broadcast via
WebSocket
    ↓ handled by
handleMessage() (index.html)
    ↓ rendered by
appendMessage() / showPromptCard()
```

---

## Problem 1: Session Discovery After Resume

### Symptom
After running `claude resume`, the mobile UI stopped updating. Users could see the session listed but no new content would stream.

### Root Cause
The server relied on `sessions-index.json` to find the active session log file. This index becomes stale after `claude resume`:
- `claude resume` creates a new JSONL session file
- The index doesn't always update in sync
- Server continued watching the old/wrong JSONL file

### Solution
Bypass `sessions-index.json` entirely. Scan JSONL files directly and use filesystem mtime.

```javascript
// server.js - discoverSessions()
// Always scan JSONL files directly - sessions-index.json can be stale
const files = fs.readdirSync(projectDir);
const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

for (const jsonlFile of jsonlFiles) {
  const fullPath = path.join(projectDir, jsonlFile);
  const stats = fs.statSync(fullPath);

  // Read first 2KB to extract cwd field
  const fd = fs.openSync(fullPath, 'r');
  const buffer = Buffer.alloc(2000);
  fs.readSync(fd, buffer, 0, 2000, 0);
  fs.closeSync(fd);

  const content = buffer.toString('utf8');
  const cwdMatch = content.match(/"cwd":"([^"]+)"/);
  // ... map cwd to session
}

// Sort by mtime descending - most recent first
const entries = project.indexData.entries
  .sort((a, b) => b.fileMtime - a.fileMtime);
```

### Prevention
- Never trust cached indexes for mtime-sensitive operations
- Always validate cache against filesystem source of truth
- Use TTL-based or event-based cache invalidation

---

## Problem 2: Permission Card False Positives

### Symptom
Permission cards appeared for auto-approved commands, creating confusing UX where users saw prompts for already-executing commands.

### Root Cause
No way to distinguish between commands waiting for permission vs auto-approved commands. Server emitted `permission_request` for all Bash/Write/Edit tool calls.

### Solution
Implement 500ms delay pattern with cancellation:

```javascript
// public/index.html - handleMessage()

// On permission_request: delay 500ms before showing
if (msg.data.type === 'permission_request') {
  window.pendingPermissionCard = { tool, cmd, isDestructive };
  window.pendingPermissionTimeout = setTimeout(() => {
    if (window.pendingPermissionCard) {
      showPromptCard({
        type: 'permission',
        text: `Allow ${tool}?`,
        command: cmd,
        isDestructive
      });
      window.pendingPermissionCard = null;
    }
  }, 500);
  break;
}

// On tool_result: cancel pending or dismiss shown card
if (msg.data.type === 'tool_result') {
  if (window.pendingPermissionTimeout) {
    clearTimeout(window.pendingPermissionTimeout);
    window.pendingPermissionTimeout = null;
    window.pendingPermissionCard = null;
  }
  if (currentPrompt?.type === 'permission') {
    hidePromptCard();
  }
}
```

Also ensure server always emits `tool_result`:

```javascript
// server.js - parseLogEntry()
if (entry.toolUseResult) {
  const result = entry.toolUseResult.stdout || entry.toolUseResult.stderr || '';
  results.push({
    type: 'tool_result',
    result: result.trim() || '(completed)',  // Always emit, even if empty
    isError: !!entry.toolUseResult.stderr && !entry.toolUseResult.stdout,
    timestamp
  });
}
```

### Prevention
- Use delayed rendering with cancellation for uncertain UI state
- Always emit completion signals regardless of output content
- Pair show/hide logic explicitly

---

## Problem 3: Prompts Missing After Background

### Symptom
Returning to the app from background didn't show pending prompts, even though Claude was waiting for input.

### Root Cause
`renderHistory()` rendered all messages but didn't check if the last item required user interaction. Prompt detection only happened for real-time messages.

### Solution
Check last history item after rendering:

```javascript
// public/index.html - renderHistory()
function renderHistory(history) {
  const outputArea = document.getElementById('outputArea');
  outputArea.innerHTML = '';
  hidePromptCard();

  history.forEach(entry => appendMessage(entry, false, true));
  outputArea.scrollTop = outputArea.scrollHeight;

  // Check if last history item needs a prompt
  if (history.length > 0) {
    const last = history[history.length - 1];

    if (last.type === 'ask_user_question' && last.questions) {
      showStructuredPrompt(last.questions);
    }
    else if (last.type === 'permission_request') {
      const sessionOption = document.querySelector(
        `#sessionSelector option[value="${currentSessionId}"]`
      );
      if (sessionOption?.dataset.status === 'waiting') {
        showPromptCard({
          type: 'permission',
          text: `Allow ${last.tool}?`,
          command: cmd,
          isDestructive
        });
      }
    }
  }
}
```

### Prevention
- Re-validate state on visibility change and reconnection
- Use idempotent state rendering (safe to call multiple times)
- Check pending state after history replay

---

## Key Components

### server.js

| Function | Purpose |
|----------|---------|
| `discoverSessions()` | Maps iTerm tabs to JSONL files |
| `watchSession()` | Sets up chokidar file watcher |
| `parseLogEntry()` | Parses JSONL entries into typed events |
| `getSessionStatus()` | Returns idle/waiting/processing based on last entry |
| `broadcastToClients()` | Sends events to all watching clients |

### public/index.html

| Function | Purpose |
|----------|---------|
| `handleMessage()` | Routes WebSocket messages to handlers |
| `renderHistory()` | Renders session history on connect |
| `appendMessage()` | Adds single message to output |
| `showPromptCard()` | Displays permission/question UI |
| `showStructuredPrompt()` | Displays AskUserQuestion with options |

---

## Testing Checklist

### Session Discovery
- [ ] Start session, verify streaming works
- [ ] Run `claude resume`, verify new session is detected
- [ ] Switch iTerm tabs, verify correct session is watched

### Permission Cards
- [ ] Auto-approved command: no card appears
- [ ] Permission-required command: card appears after ~500ms
- [ ] Approve in terminal: card dismisses on mobile
- [ ] Approve on mobile: command executes

### State Recovery
- [ ] Background app while prompt is showing
- [ ] Return to app: prompt should still be visible
- [ ] Disconnect WebSocket, reconnect: state should recover

---

## Related Documentation

- [Triaging Multi-Agent Review Findings](triaging-multi-agent-review-findings.md) - Phase 1 review triage, Swift 6 concurrency gotchas
- [SwiftUI Review Findings Consolidation](../code-quality/swiftui-review-findings-consolidation.md) - Phase 2 review: shared singletons, diff caching, scroll debounce patterns

## Related Files

| File | Description |
|------|-------------|
| `server.js` | Express + WebSocket server |
| `public/index.html` | Mobile-optimized SPA |
| `start.sh` | Server startup script |
| `restart.sh` | Stop + start with PM2 handling |
| `CLAUDE.md` | Project documentation |
