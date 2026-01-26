---
title: Mobile Permission Granting for Commands
type: feat
date: 2026-01-26
---

# Mobile Permission Granting for Commands

## Problem Statement

When Claude Code wants to execute a command that requires permission (Bash, Write, Edit), the permission dialog appears in the terminal but is NOT logged to the JSONL files. The mobile app has no visibility into this state - users can't tell when Claude is waiting for permission.

## Proposed Solution

Show a permission card on mobile when we see tool calls that typically require permission. This is heuristic-based (may show for auto-approved commands), but gives users a clear UI indication that they may need to respond.

### Server Changes (`server.js`)

Modify `parseLogEntry` to emit `permission_request` for permission-requiring tools:

```javascript
// In parseLogEntry, tool_use handling
else if (block.type === 'tool_use') {
  if (block.name === 'AskUserQuestion' && block.input?.questions) {
    results.push({ type: 'ask_user_question', questions: block.input.questions, timestamp });
  }
  // Permission-requiring tools
  else if (['Bash', 'Write', 'Edit', 'MultiEdit'].includes(block.name)) {
    results.push({ type: 'permission_request', tool: block.name, input: block.input || {}, timestamp });
  }
  else {
    results.push({ type: 'tool', tool: block.name || 'unknown', input: block.input || {}, timestamp });
  }
}
```

### Client Changes (`public/index.html`)

**Handle `permission_request` inline in `handleMessage`:**

```javascript
// In handleMessage, claude_output case:
if (msg.data.type === 'permission_request') {
  const input = msg.data.input || {};
  const tool = msg.data.tool;
  const cmd = tool === 'Bash' ? (input.command || '') : `${tool}: ${input.file_path || 'unknown'}`;
  const isDestructive = tool === 'Bash' && /\brm\b|\bdelete\b|\bdrop\b/.test(cmd.toLowerCase());

  showPromptCard({
    type: 'permission',
    text: `Allow ${tool}?`,
    command: cmd,
    isDestructive
  });
  break;
}
```

**Auto-dismiss on tool_result (already handled elsewhere):**

When `tool_result` is received, dismiss any pending permission card since the command already ran.

## Limitations (Accepted)

- **False positives**: Auto-approved commands still show cards briefly
- **Race conditions**: User may respond in terminal before mobile card appears
- **Not deterministic**: We're guessing based on tool type, not actual permission state

These are acceptable tradeoffs for having a UI indication.

## Acceptance Criteria

- [x] Bash tool calls show permission card with command preview
- [x] Write/Edit tool calls show permission card with file path
- [x] Yes sends `y`, No sends `n`
- [x] Destructive commands (rm, delete) show warning styling
- [x] Card auto-dismisses if tool_result received

## Files to Modify

| File | Changes |
|------|---------|
| `server.js:~383` | Add `permission_request` type in `parseLogEntry` |
| `public/index.html:~1320` | Handle `permission_request` inline in `handleMessage` |
