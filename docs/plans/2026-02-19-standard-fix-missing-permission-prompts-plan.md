---
title: "Fix Missing Permission Prompts for Read, WebFetch, and Fetch"
type: standard
status: ready_for_review
date: 2026-02-19
tags:
  - bug-fix
  - permissions
  - log-parser
  - watcher
---

# Fix Missing Permission Prompts for Read, WebFetch, and Fetch

## Problem

When Claude Code is waiting for user approval on Read, WebFetch, or Fetch tools, our app doesn't show a permission prompt. The session hangs with no visible way to approve remotely.

**Root cause:** `loadAllowedTools()` in `lib/session-discovery.js` hardcodes Read, Glob, Grep, WebSearch, and WebFetch as "always allowed." `needsPermission()` returns false regardless of whether Claude Code is actually waiting. This was added to prevent permission flooding (80+ prompts/session — solution #5), but it overcorrects: it suppresses REAL permission prompts when the user hasn't auto-allowed these tools in Claude Code's settings.

**Secondary issue:** Main session watcher has no deferral mechanism — only subagent watchers defer permissions by one poll cycle to distinguish auto-approved tools from genuine permission waits.

## Goals

1. Show permission prompts for ALL tools Claude Code is genuinely waiting on
2. Don't re-introduce permission flooding for auto-approved tools
3. Handle both main session and subagent permission detection correctly

## Solution

Remove read-only tools from the hardcoded "always allowed" list. Keep only truly internal tools (that Claude Code never prompts for). Rely on Claude Code's actual settings (loaded from settings files) plus a deferral mechanism to distinguish real permission waits from auto-approved tool uses.

## Technical Approach

### Step 1: Reduce hardcoded allowlist to internal-only tools

In `lib/session-discovery.js` `loadAllowedTools()`, remove read-only tools from the hardcoded `allowed` set:

**Current (overcorrects):**
```javascript
const allowed = new Set([
  'TodoRead', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
  'EnterPlanMode', 'ExitPlanMode', 'Skill', 'NotebookRead',
  'Read', 'Glob', 'Grep',           // ← REMOVE
  'WebSearch', 'WebFetch',           // ← REMOVE
  'Task', 'TaskOutput', 'TaskStop',
  'AskUserQuestion', 'SendMessage', 'TeamCreate', 'TeamDelete',
]);
```

**After (only tools Claude Code never prompts for):**
```javascript
const allowed = new Set([
  'TodoRead', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
  'EnterPlanMode', 'ExitPlanMode', 'Skill', 'NotebookRead',
  'Task', 'TaskOutput', 'TaskStop',
  'AskUserQuestion', 'SendMessage', 'TeamCreate', 'TeamDelete',
]);
```

Claude Code's actual settings continue to be loaded from settings files. If the user has auto-allowed Read/WebFetch there, `needsPermission()` will still return false.

### Step 2: Add deferral to main session permission detection

In `lib/watcher.js` `processLogChanges()`, apply the same deferral pattern that subagent watchers use:

- For `permission_request` entries, store in a `pendingMainPermissions` Map (keyed by toolUseId)
- On next poll cycle (2s), check if a `tool_result` arrived for that toolUseId
- If yes → cancel permission (was auto-approved), emit as regular `tool`
- If no → broadcast as `permission_request`

This prevents false prompts when Claude Code auto-approves a tool between poll cycles.

### Step 3: Verify Fetch tool handling

Check Claude Code JSONL logs for whether `Fetch` exists as a distinct tool name (vs `WebFetch`). If it exists (possibly an MCP tool), ensure the log parser handles it. If it's just the user referring to `WebFetch`, no action needed.

## Implementation Steps

1. Update `loadAllowedTools()` — remove Read, Glob, Grep, WebSearch, WebFetch from hardcoded set
2. Add `pendingMainPermissions` Map to watcher factory state
3. Modify `processLogChanges()` to defer permission broadcasts
4. Add fallback poll handling for deferred main permissions
5. Add tests for the new behavior
6. Verify Fetch tool name in actual logs

## Affected Files

| File | Change |
|------|--------|
| `lib/session-discovery.js` | Remove read-only tools from hardcoded allowlist |
| `lib/watcher.js` | Add deferral mechanism to main session `processLogChanges()` |
| `test/` | New tests for permission detection with reduced allowlist + main deferral |

## Acceptance Criteria

1. Read/WebFetch/Glob/Grep/WebSearch permission prompts appear when Claude Code is genuinely waiting for approval
2. No permission flooding when Claude Code auto-approves these tools (deferral catches auto-approvals)
3. Internal tools (TodoRead, TaskCreate, etc.) are never prompted
4. Main session permissions use deferral to prevent false positives
5. Subagent deferral continues to work correctly
6. Existing 272 tests still pass

## Test Strategy

- `needsPermission()` returns true for Read/WebFetch when NOT in Claude Code settings
- `needsPermission()` returns false for Read/WebFetch when loaded from Claude Code settings
- Main deferral: tool_use + tool_result across batches → no prompt
- Main deferral: tool_use with no tool_result after timeout → prompt shown
- Existing subagent deferral tests still pass

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Permission flooding regression if settings files can't be loaded | MEDIUM | Deferral mechanism catches auto-approved tools regardless of allowlist |
| False prompts during fast auto-approved operations | LOW | 2-second deferral timeout (same as proven subagent pattern) |
| Ghost tick after clearing deferral timers | LOW | Guard with state existence check (learned from solution #4) |

## Past Learnings Applied

- **Solution #5** (permission-flood): Original reason for hardcoded set — replacing overcorrection with timing-based detection
- **Solution #3** (deferred-permissions-trapped): Deferral + fallback poll pattern prevents permissions from getting stuck
- **Solution #4** (ghost-tick): Guard against ghost ticks when cleaning up deferral timers
- **Solution #2** (permissions-dropped-on-processing): Don't nuke pending permissions on session status changes
