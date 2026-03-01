---
status: ready_for_review
tier: standard
date: 2026-02-17
tags: [permissions, tool-approval, fallback, ios, web]
---

# Manual Approval Fallback from Session View

## Problem

When Claude Code requests tool approval, the iOS app sometimes fails to show the permission prompt card (batch rejections per #30, timing issues, coalescing edge cases). The user can see the session output has stopped and the status is "waiting", but has no way to approve because the prompt card didn't appear. They're stuck unless they kill the app or switch sessions.

## Goals

1. Provide a fallback approval mechanism when the PromptCardView system fails
2. Allow users to approve/deny tool use directly from the session view
3. Work on both iOS and web clients
4. Not interfere with the existing PromptCardView system when it works correctly

## Solution

Add a **"Waiting for approval" fallback row** above the InputBarView that appears when:
- Session status is `.waiting`
- No prompt card is currently visible (`currentPrompt == nil`)
- The state has persisted for 2+ seconds (debounce to avoid flickering during normal prompt card rendering)

The row shows: `⚠️ Waiting for approval` with `[Allow]` `[Always]` `[Deny]` capsule buttons. Tapping injects the corresponding command (`y` / `always` / `n`) to the terminal via the existing inject mechanism.

## Technical Approach

**iOS — InputBarView.swift:**
- Add a `fallbackApprovalRow` view that appears conditionally
- Reads `coordinator.appState.sessionStatus` and `coordinator.promptService.currentPrompt`
- Uses a 2-second delayed flag (`showFallbackApproval`) set via `.onChange` + `Task.sleep`
- Buttons call `coordinator.injectRawCommand("y")` / `"always"` / `"n"`
- Row dismisses when session status changes from `.waiting` or when a prompt card appears

**iOS — AppCoordinator.swift:**
- Add `injectRawCommand(_ command: String)` public method that sends inject to the current session
- Reuses existing `webSocket.send()` inject path

**Web — public/js/prompts.js:**
- Add `showFallbackApproval()` / `hideFallbackApproval()` functions
- Show after 2s delay when session status is "waiting" and no prompt card visible
- Hide when prompt card appears or status changes
- Buttons call existing `injectCommand()` with "y" / "always" / "n"

## Implementation Steps

1. **iOS: Add fallback row to InputBarView** — conditional `fallbackApprovalRow` above `suggestionChipRow` / utility row
2. **iOS: Add `injectRawCommand` to AppCoordinator** — simple wrapper for the inject WebSocket message
3. **iOS: Add debounce logic** — 2s delay before showing, immediate hide on state change
4. **Web: Add fallback approval div** — positioned above input area, same visibility logic
5. **Web: Wire buttons to inject** — reuse existing `injectCommand()`
6. **Tests** — iOS: test fallback visibility logic (waiting + no prompt → show, prompt appears → hide)

## Affected Files

| File | Change |
|------|--------|
| `ClaudeRemote/Sources/ClaudeRemote/Views/InputBarView.swift` | Add `fallbackApprovalRow` view |
| `ClaudeRemote/Sources/ClaudeRemote/Services/AppCoordinator.swift` | Add `injectRawCommand()` method |
| `public/js/prompts.js` | Add fallback approval show/hide + buttons |
| `public/index.html` | Add fallback approval container div |
| `ClaudeRemote/Tests/ClaudeRemoteTests/Views/InputBarViewTests.swift` | Test fallback visibility logic |

## Acceptance Criteria

- [ ] Fallback approval row appears after 2s when session is "waiting" and no prompt card visible
- [ ] Tapping "Allow" injects "y" and unblocks the session
- [ ] Tapping "Always" injects "always" and unblocks the session
- [ ] Tapping "Deny" injects "n"
- [ ] Fallback row disappears immediately when a prompt card appears
- [ ] Fallback row disappears when session status changes from "waiting"
- [ ] Works on both iOS and web clients
- [ ] Does not interfere with normal PromptCardView operation

## Spec-Flow Analysis

| Flow | Happy Path | Error State | Edge Case |
|------|-----------|-------------|-----------|
| Normal prompt | PromptCard appears → user taps → injected | PromptCard fails → fallback appears after 2s | Both appear simultaneously → fallback hides immediately |
| Fallback approve | Row appears → user taps Allow → injected → row hides | Inject fails → session stays waiting → user can retry | Rapid status changes → debounce prevents flickering |
| Session switch | User switches session → fallback resets | N/A | Switch during 2s debounce → timer cancelled |
| Prompt card late arrival | Fallback showing → prompt card arrives → fallback hides | N/A | Prompt arrives at exactly 2s boundary → fallback flickers (acceptable) |

## Test Strategy

- Test fallback shows when: waiting + no prompt + 2s elapsed
- Test fallback hides when: prompt appears, status changes, session switches
- Test debounce: rapid waiting→processing→waiting doesn't flicker
- Test inject sends correct command for each button

## Risks

| Risk | Mitigation |
|------|-----------|
| User approves via fallback while prompt card is loading → double injection | Fallback immediately hides when prompt card appears; 2s delay prevents overlap |
| "Always" from fallback doesn't track toolUseId | Acceptable — terminal receives "always" directly, Claude Code handles the grant. Server-side grant tracking may miss it but client-side approval still works |
| 2s delay feels slow | Can tune to 1.5s; must be long enough for normal prompt card rendering |

## Past Learnings Applied

- **Permission queue architecture** (from permission-queue-concurrent-subagents solution): Fallback intentionally avoids the queue system — it's a direct bypass
- **500ms coalesce delay** (from claude-code-remote-monitoring): The 2s fallback delay exceeds the 500ms coalesce, ensuring the normal path has time to work
- **Ink TUI mechanics** (from exitplanmode solution): Direct "y"/"n"/"always" injection works for permission prompts (they're text-based, not Ink selectors)
