---
title: "fix: Permission queue for concurrent subagent permissions"
type: fix
date: 2026-02-01
---

# fix: Permission queue for concurrent subagent permissions

## Overview

When Claude Code spawns many subagents in parallel (planning, brainstorming, reviewing), each can request permissions (Bash, Write, Edit). The iOS app currently handles exactly ONE permission at a time — new ones silently overwrite the previous. Subagent permissions are completely suppressed (never shown). Users see no prompts and sessions hang waiting for responses.

This plan adds a stacked permission queue that shows ALL pending permissions vertically, and routes subagent permissions through the existing prompt system.

## Problem Statement

Two distinct bugs combine to create the issue:

1. **Subagent permissions are suppressed.** `AppCoordinator.routeMessage()` has `case .subagentOutput: break` — all subagent output is dropped. The server sends subagent `permission_request` items wrapped in `subagent_output` messages, so they never reach `PromptService`.

2. **Single-prompt architecture.** `PromptService.currentPrompt` is a single `PromptItem?`. `handlePermissionRequest()` calls `cancelPendingPermission()` before starting a new 500ms delay — meaning if two permissions arrive in quick succession, the first is silently lost.

## Proposed Solution

### A. Route subagent permissions to PromptService

In `AppCoordinator.routeMessage()`, detect `permission_request` and `ask_user_question` types inside `subagentOutput` data and forward them to `promptService.handleClaudeOutput()` instead of suppressing.

### B. Replace single prompt with queue

In `PromptService`:
- Replace `currentPrompt: PromptItem?` → `promptQueue: [PromptItem]`
- Replace `pendingPermission: PromptItem?` → `pendingPermissions: [String: PromptItem]` (keyed by `toolUseId`)
- Replace `delayTask: Task<Void, Never>?` → `delayTasks: [String: Task<Void, Never>]`
- Queue head is the "active" prompt for voice auto-mode and response targeting

### C. Update UI to show stacked queue

Replace single `PromptCardView` with a bounded `ScrollView` stack showing up to 3 fully-rendered cards plus a "+N more" indicator.

## Technical Considerations

### Subagent injection routing

Subagent permissions are brokered by the parent Claude process. The permission prompt appears in the **parent session's terminal**. Injecting "y"/"n"/"always" into the parent TTY via the existing `inject` action is correct — no server changes needed for response routing.

**However**, the parent session shows these prompts sequentially. The parent waits for each subagent permission to be answered before presenting the next. This means the iOS queue is a client-side queue that mirrors what the parent terminal would show one-at-a-time. Multiple permissions may be *pending* in subagent logs, but the parent terminal only surfaces one at a time.

**Implication**: The queue shows the current parent-level permission (from `claudeOutput`) AND any subagent permissions detected in `subagentOutput` that haven't been surfaced by the parent yet. The user can only respond to the one the parent is actively waiting on (queue head). Other items are informational until they become active.

### 500ms delay per queue item

Each incoming `permission_request` gets its own independent 500ms delay timer, keyed by `toolUseId`. This prevents auto-approved tools from flashing in the queue. The single `delayTask` pattern doesn't scale to concurrent permissions.

### tool_result matching for queue dismissal

When a `tool_result` arrives, match by `toolUseId` to dismiss the correct queue entry. Fall back to dismissing the oldest permission if no `toolUseId` match exists. This prevents dismissing the wrong item.

### "Allow Always" cascade

After sending "always" for a tool, proactively remove other queue items with the same tool name. The server-side auto-approval will handle them, but instant client-side removal avoids a flickering dismiss cascade.

### Voice auto-mode

Voice auto-mode processes queue head only. After responding, the next item becomes head and triggers a new TTS-then-listen cycle. No bulk voice handling.

### History recovery

`recoverFromHistory` must find ALL unmatched `permission_request` entries (not just the last one) by scanning for permission_request/tool_result pairs.

## Acceptance Criteria

- [x] Subagent `permission_request` messages route to `PromptService` (not suppressed)
- [x] Multiple concurrent permissions queue instead of overwriting
- [x] Each queue item has independent 500ms auto-approve delay
- [x] `tool_result` dismisses the correct queue item by `toolUseId`
- [x] "Allow Always" cascade removes matching tool permissions from queue
- [x] Queue UI shows up to 3 cards with "+N more" overflow indicator
- [x] Subagent permission cards show agent description label
- [x] Queue head is the actionable item; others show as pending
- [x] Session switch clears the entire queue
- [x] Voice auto-mode processes queue head sequentially
- [x] History recovery restores all pending permissions
- [x] `pendingPromptMessage` dead code in AppState removed
- [x] All existing prompt tests updated, new queue tests added
- [x] `swift build` clean, `swift test` passes

## Dependencies & Risks

### Dependencies
- No server changes required — subagent permissions already broadcast as `subagent_output`
- No new WebSocket message types needed
- Existing `inject` action works for subagent permission responses

### Risks
- **Subagent permission timing**: Subagent permissions in their JSONL may arrive before the parent session surfaces the prompt. Queue items from `subagentOutput` are informational until the parent actually asks. Responding to a not-yet-active permission would inject into the TTY prematurely.
  - **Mitigation**: Only allow response on queue head. Mark non-head items as "Pending" with disabled buttons.
- **Queue overflow**: Runaway multi-agent sessions could generate dozens of permissions.
  - **Mitigation**: Cap rendered items at 3, show "+N more" badge, internal queue unlimited.
- **Staleness complexity**: Per-item staleness tracking adds complexity vs. global counter.
  - **Mitigation**: Keep global staleness for V1 — mark all items stale if 2+ messages arrive while queue is non-empty.

## Files to Modify

| File | Change |
|------|--------|
| `PromptService.swift` | Replace single-prompt state with queue; per-item delay timers; toolUseId matching; cascade logic; history recovery |
| `AppCoordinator.swift` | Route `subagentOutput` permission_request/ask_user_question to `PromptService`; update voice auto-mode for queue head |
| `PromptCardView.swift` | Stack layout with ScrollView; overflow indicator; agent label on subagent cards; disabled state for non-head items |
| `ContentView.swift` | Update `.safeAreaInset` to accommodate queue height with max bound |
| `AppState.swift` | Remove dead `pendingPromptMessage` |
| `WebSocketMessage.swift` | Add `toolUseId` extraction to `ClaudeOutputData` if not already present; ensure `subagentOutput` data decodes `permission_request` fields |
| `AppCoordinatorTests.swift` | Update existing prompt tests; add queue tests (concurrent permissions, cascade, dismissal, session switch, subagent routing) |

## References

- Current `PromptService`: `ClaudeRemote/Sources/ClaudeRemote/Services/PromptService.swift`
- Current `PromptCardView`: `ClaudeRemote/Sources/ClaudeRemote/Views/Components/PromptCardView.swift`
- Subagent output suppression: `AppCoordinator.swift:349-350`
- Server subagent broadcast: `server.js:721-752`
- Server inject handler: `server.js:1329-1369`
- Learned pattern — per-item delay timers: `docs/solutions/integration-issues/claude-code-remote-monitoring.md`
- Learned pattern — fire-and-forget task risks: `docs/solutions/logic-errors/swift-structured-concurrency-pitfalls-observable-classes.md`
- Learned pattern — generation counter for stale callbacks: `docs/solutions/concurrency-issues/trigger-word-phase5-audio-arbitration.md`
- Learned pattern — session switch race conditions: `docs/solutions/code-quality/phase-8-review-fixes-race-security-perf.md`
