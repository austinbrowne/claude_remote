---
type: standard
title: "Fix ExitPlanMode to present question and process response"
date: 2026-02-04
status: complete
security_sensitive: false
priority: medium
issue: 9
---

# Plan: Fix ExitPlanMode to present question and process response

## Problem

When Claude Code uses the `ExitPlanMode` tool to exit plan mode and request user approval, the iOS app does not display any prompt to the user. The server detects the tool use and broadcasts a `mode_change` message, but this is treated as an informational state change rather than an interactive approval flow. The user never sees the plan or gets a chance to approve/reject/modify it.

**Impact:** Users cannot approve or reject plans from the iOS app. Plan mode exits automatically without user consent, breaking the approval workflow that Claude Code expects.

## Goals

- Display ExitPlanMode as an interactive prompt card with appropriate options
- Allow user to select from the actual ExitPlanMode options (not simplified binary)
- Default to option 2 ("auto-accept edits") to preserve context
- Route the response back to Claude Code via the existing `selectOption` mechanism (arrow keys + Enter)

## Solution

Extend the existing prompt handling architecture (used for `permission_request` and `ask_user_question`) to support `exit_plan_mode`. When the server detects `ExitPlanMode` tool use, it will emit an `exit_plan_mode` message via the `claudeOutput` channel (as a `ClaudeOutputData.type`, not a new `ServerMessage` case). The iOS app will display this as a prompt card with options matching Claude Code's 4 choices. The user's selection will be sent back to Claude Code via the `selectOption` action (arrow keys + Enter).

**Key insight from exploration:** ExitPlanMode doesn't carry a plan summary in its input — it just signals that the plan is ready. The plan content lives in the file Claude wrote.

**Response format (CRITICAL — from research):** ExitPlanMode presents **4 options** to the user:
1. "Yes, clear context and auto-accept edits" (shift+tab) — **DEFAULT, DESTRUCTIVE** (clears conversation)
2. "Yes, auto-accept edits" — preserves context (**recommended**)
3. "Yes, manually approve edits"
4. Free-form text input for modifications

Binary y/n is **NOT** appropriate. The iOS app must either:
- Present all 4 options
- Present simplified options that use `selectOption` action with the correct index
- Default to option 2 (preserve context) to avoid accidental context loss

**Response mechanism (CRITICAL — from codebase analysis):** ExitPlanMode uses an **ink-based TUI selector**, the same as `AskUserQuestion`. This means:
- **Do NOT use `inject` action** — typed text is ignored by ink Select components
- **Use `selectOption` action** with arrow-key navigation (existing pattern in `PromptService.respondOption()`)
- Option indices are 0-based: option 1 = index 0, option 2 = index 1, option 3 = index 2
- For option 4 (free text), use `inject` action after selecting the text input field

**Sources:**
- [GitHub Issue #18599](https://github.com/anthropics/claude-code/issues/18599) — documents all 4 options
- [ExitPlanMode tool description](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-exitplanmode.md)

## Technical Approach

### Message Flow

1. **Claude Code** calls `ExitPlanMode` tool
2. **Server (server.js)** detects `ExitPlanMode` in JSONL, emits `exit_plan_mode` message
3. **iOS (AppCoordinator)** receives message, routes to `PromptService.handleClaudeOutput()`
4. **PromptService** enqueues as new `PromptKind.planExit`
5. **PromptCardView** renders approval buttons
6. **User taps** option → `PromptService.respondPlanExit()` → sends `selectOption` action
7. **Server** receives action, sends arrow keys + Enter to TTY → Claude Code receives selection

### Reuse Pattern from AskUserQuestion

The exploration found that `AskUserQuestion` follows this exact pattern:
- Server emits `ask_user_question` with `questions` array
- iOS creates `PromptItem(kind: .question(questions:))`
- User response via `respondOption()` or `respond(text:)`

ExitPlanMode will follow the same flow with a new `PromptKind.planExit` variant.

## Implementation Steps

1. **Server (server.js)** — Emit `exit_plan_mode` message type
   - In `parseLogEntry()`, when detecting `ExitPlanMode`, emit `{ type: 'exit_plan_mode', timestamp }`
   - Keep `mode_change` emission for state tracking (separate concern)

2. **WebSocketMessage.swift** — Add ClaudeOutputData handling
   - `exit_plan_mode` will be handled via existing `ClaudeOutputData` routing (type field check)
   - No new ServerMessage enum case needed — reuse `claudeOutput` path

3. **AppCoordinator.swift** — Route exit_plan_mode to PromptService
   - In the `.claudeOutput` handler, add condition: `if data.type == "exit_plan_mode"`
   - Route to `promptService.handleClaudeOutput(data)`

4. **PromptService.swift** — Add planExit handling
   - Add `case planExit` to `PromptKind` enum
   - Add `handlePlanExit()` method that creates `PromptItem(kind: .planExit)`
   - Add `respondPlanExit(option: PlanExitOption)` method with options:
     - `.acceptPreserveContext` — sends `selectOption(index: 1)` (option 2, 0-indexed)
     - `.acceptClearContext` — sends `selectOption(index: 0)` (option 1, 0-indexed)
     - `.requestChanges(text: String)` — sends `selectOption(index: 3)` then `inject(text)`
   - Prompt dismisses immediately on user tap (like questions), not on tool_result
   - **PlanExitOption enum definition:**
     ```swift
     enum PlanExitOption {
         case acceptPreserveContext  // Option 2: preserves conversation context
         case acceptClearContext     // Option 1: clears context (destructive)
         case manualApprove          // Option 3: manually approve each edit
         case requestChanges(String) // Option 4: free-form modification text
     }
     ```

5. **PromptCardView.swift** — Render planExit prompt
   - Add case for `.planExit` in the prompt card rendering
   - Display "Plan ready" with 3 buttons:
     - "Accept (preserve context)" — **primary/default**
     - "Accept (clear context)" — secondary, with warning indicator
     - "Request changes" — opens text input
   - Style with plan-themed colors (distinct from permissions)

6. **AppCoordinator.swift** — Add voice and notification support
   - Add planExit case to `toolSpeechSummary()` for voice auto-mode
   - Add notification trigger for `exit_plan_mode` (similar to question notification)

7. **Tests** — Add coverage for new flow
   - Test server emits `exit_plan_mode` on ExitPlanMode detection
   - Test iOS routes to PromptService and enqueues correctly
   - Test response path injects correct command
   - Test history recovery for pending planExit prompts

## Affected Files

| File | Change |
|------|--------|
| `server.js` | Emit `exit_plan_mode` message in `parseLogEntry()` |
| `AppCoordinator.swift` | Route `exit_plan_mode` type to PromptService |
| `PromptService.swift` | Add `PromptKind.planExit`, handler, and response method |
| `PromptCardView.swift` | Render planExit prompt card with Approve/Reject buttons |
| `PromptServiceTests.swift` | Add tests for planExit handling |
| `AppCoordinator.swift` | Add voice speech summary and notification for planExit |
| `VoicePromptMatcher.swift` | Add `.planExit` case (required — will fail to compile otherwise) |

## Acceptance Criteria

- [ ] Server detects ExitPlanMode tool use and emits `exit_plan_mode` message
- [ ] iOS displays a prompt card when `exit_plan_mode` is received
- [ ] Prompt card shows "Plan ready" with 3 primary options: "Accept (preserve context)", "Accept (clear context)", "Request changes"
- [ ] "Accept (preserve context)" injects option 2 response — **DEFAULT**
- [ ] "Accept (clear context)" injects option 1 response
- [ ] "Request changes" allows text input (option 4)
- [ ] Prompt is dismissed after response
- [ ] Works with existing prompt queue (doesn't break permissions/questions)
- [ ] Tests passing
- [ ] History recovery works for pending planExit on reconnect
- [ ] Voice auto-mode announces plan approval prompt
- [ ] Push notification triggers for planExit when app is backgrounded

## Test Strategy

- **Unit tests:**
  - `handlePlanExit()` creates correct PromptItem with `kind: .planExit`
  - `respondPlanExit(.acceptPreserveContext)` sends `selectOption(index: 1)`
  - `respondPlanExit(.acceptClearContext)` sends `selectOption(index: 0)`
  - `respondPlanExit(.manualApprove)` sends `selectOption(index: 2)`
  - `respondPlanExit(.requestChanges("fix X"))` sends `selectOption(index: 3)` then `inject("fix X")`

- **Integration tests:**
  - Full flow from server emission to iOS prompt display
  - Response routing back through selectOption action
  - Verify arrow-key navigation reaches Claude Code correctly

- **Edge cases:**
  - ExitPlanMode arrives while other prompts are queued
  - Session switch clears pending planExit prompts
  - Stale response after Claude Code timeout (verify graceful handling)

## Security Review

- [x] Low risk — reuses existing `selectOption` mechanism with hardcoded indices (0, 1, 2, 3)
- [x] For "Request changes" option, user text flows through existing `inject` sanitization (server.js control-char stripping, length limit, AppleScript escaping)

## Past Learnings Applied

- **permission-queue-concurrent-subagents.md**: Use FIFO queue with `arrivalCounter` for prompt ordering. Don't use single-item state. Two-phase operations (cancel/dismiss) must be mutually exclusive.
- **claude-code-remote-monitoring.md**: Follow the 500ms delay pattern for uncertain prompts (though planExit likely always shows immediately).
- **subagent-tool-flooding-and-task-id-mapping.md**: Match field names exactly between server emission and iOS decoder. Test full message flow.
- **swarm-fix-parallel-code-review-findings.md**: Filter by sessionId at handler entry point before processing.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| ExitPlanMode schema changes in Claude Code | Low | Medium | Check Claude Code docs for any input parameters we should extract |
| Response timing — user responds after timeout | Low | Low | Claude Code handles stale responses gracefully |
| Queue ordering issues with mixed prompt types | Low | Medium | Reuse existing queue infrastructure, add specific tests |
| mode_change and exit_plan_mode ordering | Low | Low | Both messages emitted together; iOS handles mode_change for state, exit_plan_mode for prompt |

## Review Findings Applied

From the 5-agent plan review:

- **[CRITICAL]** Response mechanism: Changed from `inject` to `selectOption` (ink-based selector requires arrow keys)
- **[HIGH]** VoicePromptMatcher: Added to affected files (required for compile)
- **[HIGH]** Test strategy: Fixed to match actual `PlanExitOption` enum, not binary y/n
- **[MEDIUM]** Message routing: Explicitly documented that `exit_plan_mode` is `ClaudeOutputData.type`, not new `ServerMessage` case
- **[LOW]** Removed "subagent ExitPlanMode" edge case — ExitPlanMode is main-agent-only

**Known limitations (deferred):**
- No plan content preview in prompt (user must see plan in terminal)
- History recovery heuristic for unanswered planExit not fully specified
