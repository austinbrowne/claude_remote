---
module: Permission System
date: 2026-02-15
problem_type: runtime_error
component: realtime
symptoms:
  - "~80 permission_request messages flood iOS app from subagent tool calls"
  - "Rate limit hit (10 requests/minute) when user taps Approve All"
  - "iOS app crashes under permission flood"
root_cause: config_error
resolution_type: code_fix
severity: critical
tags: [permission, subagent, loadAllowedTools, flood, rate-limit, websocket]
language: javascript
framework: express
---

# Troubleshooting: Subagent Permission Flood from Narrow allowedTools Set

## Problem
Subagents generated ~80 permission_request messages because `loadAllowedTools()` only included internal tools, causing every Read/Glob/Grep call to require explicit permission.

## Environment
- Module: Permission System (server.js)
- Language/Framework: JavaScript / Express + WebSocket
- Affected Component: `loadAllowedTools()`, `needsPermission()`, subagent watcher
- Date: 2026-02-15

## Symptoms
- ~80 permission_request messages flood the iOS app during a multi-agent session
- User hits the 10 request/minute rate limit when tapping "Approve All"
- iOS app becomes unresponsive and crashes under the flood
- Every Read, Glob, Grep, WebSearch tool call from subagents appears as a permission prompt

## What Didn't Work

**Direct solution:** The problem was identified and fixed on the first attempt by tracing through `needsPermission()` → `loadAllowedTools()` → `parseLogEntry()`.

## Solution

Expanded `loadAllowedTools()` to include read-only and safe tools that don't need user permission:

```javascript
// Before (broken) — only internal tools:
const allowed = new Set([
  'TodoRead', 'TodoWrite',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
  'EnterPlanMode', 'ExitPlanMode',
  'Skill', 'NotebookRead',
  'AskUserQuestion',
  'SendMessage', 'TeamCreate', 'TeamDelete',
]);

// After (fixed) — include read-only tools:
const allowed = new Set([
  'TodoRead', 'TodoWrite',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
  'EnterPlanMode', 'ExitPlanMode',
  'Skill', 'NotebookRead',
  'Read', 'Glob', 'Grep',           // <-- read-only file ops
  'WebSearch', 'WebFetch',           // <-- web ops
  'Task', 'TaskOutput', 'TaskStop',  // <-- subagent management
  'AskUserQuestion',
  'SendMessage', 'TeamCreate', 'TeamDelete',
]);
```

## Why This Works

1. **Root cause:** `needsPermission()` checks `loadAllowedTools()` to decide whether a tool call generates a `permission_request` (needs user approval) or a regular `tool` message (auto-approved). The set was too narrow — it only included Claude Code internal tools, not the common read-only tools that agents use heavily.
2. Read, Glob, Grep, WebSearch are safe operations that don't modify state. They should never require explicit user permission.
3. Subagents call these tools dozens of times per turn, so each missing entry multiplied into dozens of unnecessary permission prompts.

## Prevention

- When adding new tool types to Claude Code, evaluate whether they need permission and add safe ones to `loadAllowedTools()`
- Test multi-agent sessions with subagents to verify permission flood doesn't recur
- Consider server-side filtering of subagent output (only broadcast `permission_request` and `ask_user_question` from subagents)
