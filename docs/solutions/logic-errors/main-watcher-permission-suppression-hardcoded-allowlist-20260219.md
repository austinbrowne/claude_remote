---
module: Permission System
date: 2026-02-19
problem_type: logic_error
component: realtime
symptoms:
  - "Permission prompts for Read, Glob, Grep, WebSearch, WebFetch silently dropped"
  - "Claude Code session hangs waiting for approval that never appears on remote client"
  - "Works for Bash/Edit/Write but not read-only tools"
root_cause: config_error
resolution_type: code_fix
severity: high
tags: [permission, allowedTools, needsPermission, deferral, watcher, main-session]
language: javascript
framework: express
related_solutions:
  - runtime-errors/subagent-permission-flood-narrow-allowedtools-20260215.md
  - concurrency-issues/subagent-deferred-permissions-trapped-by-batch-filter.md
---

# Troubleshooting: Main Watcher Permission Suppression from Hardcoded Allowlist

## Problem
Permission prompts for Read, Glob, Grep, WebSearch, and WebFetch were silently dropped — Claude Code sessions would hang waiting for user approval that never appeared on the remote client. Only Bash/Edit/Write permissions came through correctly.

## Environment
- Module: Permission System (lib/session-discovery.js, lib/watcher.js)
- Language/Framework: JavaScript / Express + WebSocket
- Affected Component: `loadAllowedTools()`, `needsPermission()`, main session watcher
- Date: 2026-02-19

## Symptoms
- Permission prompts for read-only tools never reach the iOS/web client
- Claude Code session appears stuck ("processing" forever) when waiting for Read/Glob/Grep/WebSearch/WebFetch permission
- Bash, Edit, Write permission prompts work correctly
- Issue occurs in restrictive permission modes where Claude Code gates read-only tools

## Root Cause
`loadAllowedTools()` in `lib/session-discovery.js` hardcoded Read, Glob, Grep, WebSearch, and WebFetch in the "always allowed" set. This caused `needsPermission()` to return `false` for these tools, so permission_request log entries for them were never broadcast to clients.

This hardcoding was introduced intentionally (see related solution: subagent-permission-flood) to prevent ~80 false permission prompts when subagents auto-approved these tools. However, it also suppressed *genuine* permission prompts when the user's Claude Code permission mode required approval for these tools.

```javascript
// BEFORE (broken): read-only tools hardcoded as always-allowed
const allowed = new Set([
  'TodoRead', 'TodoWrite', /* ... internal tools ... */
  'Read', 'Glob', 'Grep',     // <-- These CAN require permission!
  'WebSearch', 'WebFetch',     // <-- depending on permission mode
]);
```

## Solution

Two-part fix:

**1. Remove read-only tools from hardcoded allowlist** (`lib/session-discovery.js`):
Only truly internal tools that Claude Code never gates remain in the set.

```javascript
// AFTER (fixed): only internal tools that Claude Code never gates
const allowed = new Set([
  'TodoRead', 'TodoWrite',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
  'EnterPlanMode', 'ExitPlanMode',
  'Skill', 'NotebookRead',
  'Task', 'TaskOutput', 'TaskStop',
  'AskUserQuestion',
  'SendMessage', 'TeamCreate', 'TeamDelete',
]);
```

**2. Add deferral mechanism to main session watcher** (`lib/watcher.js`):
Hold `permission_request` items for one poll cycle (~2s). If a `tool_result` arrives in the next batch, the tool was auto-approved — cancel the prompt silently. If no `tool_result` arrives, the permission is genuinely pending — broadcast it to clients.

This three-phase approach:
- Phase 1: Collect resolved toolUseIds from current batch
- Phase 2: Flush deferred permissions from previous cycle (resolve or broadcast)
- Phase 3: Classify new items (same-batch auto-approve, defer, or pass through)

## Key Insight
**Don't suppress permissions by tool name — suppress by timing.** Name-based suppression (hardcoded allowlist) is brittle because whether a tool needs permission depends on the user's Claude Code settings, not the tool's identity. Timing-based deferral (one poll cycle) correctly distinguishes auto-approved from genuinely pending regardless of tool name or permission mode.

## Prevention
- Never hardcode tool names as "always allowed" unless the tool is truly internal to Claude Code (meta/orchestration tools only)
- For tools that *might* need permission depending on settings, use the deferral pattern
- The subagent watcher already had this pattern — the main watcher was missing it

## Related
- `runtime-errors/subagent-permission-flood-narrow-allowedtools-20260215.md` — the original flooding fix that this solution partially reverses
- `concurrency-issues/subagent-deferred-permissions-trapped-by-batch-filter.md` — the subagent deferral pattern this solution extends to the main watcher

## Verification
```bash
node --test test/main-watcher-deferred-permissions.test.js
```
5 test cases: same-batch auto-approval, cross-batch deferral, cross-batch resolution, mixed batch, no-toolUseId fallthrough.
