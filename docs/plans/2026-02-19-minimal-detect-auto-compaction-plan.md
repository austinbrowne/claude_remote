---
title: Detect Auto-Compaction in Session Logs
type: minimal
status: ready_for_review
date: 2026-02-19
---

# Detect Auto-Compaction in Session Logs

## Problem

Auto-compaction (triggered when context hits ~95%) produces no visible indicator on the remote client. The existing detection only catches manual `/compact` command output (`<local-command-stdout>` containing "Compacted"). Auto-compaction writes a user entry with `isCompactSummary: true` to the JSONL, but the log parser treats it as a regular user message — the summary text floods the chat instead of showing a clean notification.

## Solution

Detect `entry.isCompactSummary === true` in `handleUserEntry()` (lib/log-parser.js) and emit `compaction_complete` instead of broadcasting the summary as a user message. Both iOS and web clients already handle `compaction_complete` with toasts — no client changes needed.

## Affected Files

| File | Change |
|------|--------|
| `lib/log-parser.js` | Add `isCompactSummary` check before "Human input" branch (~3 lines) |
| `test/compaction.test.js` | Add test case for `isCompactSummary: true` entries |

## Implementation Steps

1. In `handleUserEntry()` (lib/log-parser.js ~line 331), add early return before `entry.isMeta` check:
   ```javascript
   else if (entry.isCompactSummary) {
     return [{ type: 'compaction_complete', content: 'Context compacted', timestamp }];
   }
   ```

2. Add test case in `test/compaction.test.js` for entry with `isCompactSummary: true`.

## Acceptance Criteria

- [ ] Auto-compaction detected from JSONL entry with `isCompactSummary: true`
- [ ] Emits `compaction_complete` (same event as manual `/compact`)
- [ ] Summary text NOT broadcast as a user message
- [ ] Existing `/compact` detection still works
- [ ] Both iOS and web clients show toast (already handled)

## Test Strategy

- Unit test: `isCompactSummary: true` user entry -> `compaction_complete` event
- Unit test: `isCompactSummary: true` does NOT produce `user` type output
- Existing tests for manual `/compact` detection still pass

## Risks

- **LOW:** `isCompactSummary` field is undocumented — could change in future Claude Code versions. If field disappears, detection silently stops (no crash), and manual `/compact` detection still works as fallback.
