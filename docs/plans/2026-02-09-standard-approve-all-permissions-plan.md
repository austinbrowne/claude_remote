---
type: standard
title: "Approve All Pending Permission Requests"
date: 2026-02-09
status: draft
security_sensitive: false
priority: medium
---

# Plan: Approve All Pending Permission Requests

## Problem

When Claude Code runs multi-agent sessions (subagents, teams), permission requests arrive in rapid bursts. Users face a wall of 5-15+ stacked permissions across different tools (Bash, Write, Read, WebFetch, etc.). The existing "Allow All [Tool]" button only cascades for a single tool type. Users must repeatedly tap through each tool category one at a time, which is tedious and blocks agent progress.

## Goals

- One-tap approval of all pending permission requests regardless of tool type
- Parity between iOS and web client implementations
- No server-side changes required (reuse existing inject + permissionToolMap protocol)

## Solution

Add an "Approve All (N)" button that appears in the prompt queue header when 2+ permissions are queued. Tapping it sends "always" for the head permission (which Claude Code processes), then cascades client-side by adding all unique tools to the `allowedTools` set and clearing the remaining permission queue. This generalizes the existing `cascadeAlwaysAllow` pattern from single-tool to all-tools.

**Why client-side cascade is sufficient:** Claude Code only blocks on the *head* permission. Once the user responds "always" to the head, Claude Code proceeds. Subsequent permissions in the queue are client-side artifacts — they'll either be auto-approved by Claude Code (because "always" was granted for that tool in the same session) or suppressed by the client's `allowedTools` set. We only need to send one "always" inject for the head permission; the rest are cleaned up locally.

## Technical Approach

**Existing pattern (from `cascadeAlwaysAllow`):**
1. User taps "Always" on head permission for tool X
2. `allowedTools.insert(X)` — future X requests auto-skipped
3. Remove all queued/pending permissions where tool == X

**New "Approve All" pattern:**
1. User taps "Approve All"
2. Collect all unique tool names from queue + pending permissions
3. Send "always" for head permission (with its toolUseId) — this unblocks Claude Code
4. `allowedTools.formUnion(allTools)` — all tools auto-skipped going forward
5. Clear all pending permissions from both `pendingPermissions` dict and `promptQueue`

This avoids sending multiple inject commands (which would race). One inject unblocks Claude Code; the client-side `allowedTools` grant handles everything else.

## Implementation Steps

### Step 1: Add `approveAll()` to PromptService (iOS)

**File:** `ClaudeRemote/Sources/ClaudeRemote/Services/PromptService.swift`

Add a new public method after `respondPermission()`:

```swift
/// Approve all pending permissions at once. Sends "always" for head, cascades the rest.
public func approveAll() {
    guard let sid = sessionId else { return }
    guard case .permission(_, _, _) = currentPrompt?.kind else { return }

    // Collect all unique tools from queue + pending
    var allTools: Set<String> = []
    for item in promptQueue {
        if case .permission(let t, _, _) = item.kind, let t { allTools.insert(t) }
    }
    for (_, pending) in pendingPermissions {
        if case .permission(let t, _, _) = pending.item.kind, let t { allTools.insert(t) }
    }

    // Send "always" for the head permission (unblocks Claude Code)
    let headToolUseId = currentPrompt?.toolUseId
    sendHandler?(.inject(command: "always", sessionId: sid, toolUseId: headToolUseId))
    dismissHead()

    // Persist all tools to allowedTools
    allowedTools.formUnion(allTools)

    // Cancel all pending permissions
    pendingPermissions.removeAll()
    coalesceTask?.cancel()
    coalesceTask = nil
    firstPendingArrival = nil

    // Clear remaining queue (only permissions — preserve questions/planExit)
    promptQueue.removeAll { item in
        if case .permission = item.kind { return true }
        return false
    }
}
```

### Step 2: Add "Approve All" button to PromptCardView (iOS)

**File:** `ClaudeRemote/Sources/ClaudeRemote/Views/Components/PromptCardView.swift`

**2a.** Pass an `onApproveAll` closure and `totalPermissionCount` into `PermissionCardContent`. Compute `totalPermissionCount` in `PromptCardView` as the count of all `.permission` items in the queue.

**2b.** Add the button inside `PermissionCardContent` after the existing batch button block (line ~244), shown only on head when `totalPermissionCount > 1` and there are mixed tools (i.e. `totalPermissionCount != sameToolCount`, so it doesn't duplicate the existing same-tool button):

```swift
// Cross-tool "Approve All" button
if totalPermissionCount > 1, totalPermissionCount != sameToolCount {
    Button {
        onApproveAll()
    } label: {
        HStack(spacing: 4) {
            Image(systemName: "checkmark.shield.fill")
            Text("Approve All (\(totalPermissionCount))")
        }
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.borderedProminent)
    .tint(.indigo)
}
```

Design rationale:
- Uses `.indigo` tint to visually distinguish from the green same-tool "Allow All" button
- Only shows when mixed tools are queued (avoids redundancy with existing same-tool button)
- SF Symbol `checkmark.shield.fill` matches existing batch button for visual consistency

### Step 3: Add "Approve All" to web client

**File:** `public/js/prompts.js`

**3a.** Add a new `approveAllPermissions()` function:

```javascript
function approveAllPermissions() {
    if (!currentPrompt || currentPrompt.type !== 'permission') return;

    // Collect all unique tools
    const allTools = new Set();
    if (currentPrompt.tool) allTools.add(currentPrompt.tool);
    for (const p of promptQueue) {
        if (p.type === 'permission' && p.tool) allTools.add(p.tool);
    }

    // Persist all tools
    for (const tool of allTools) {
        alwaysAllowedTools.add(tool);
    }

    // Remove all permission prompts from queue (keep questions)
    for (let i = promptQueue.length - 1; i >= 0; i--) {
        if (promptQueue[i].type === 'permission') {
            promptQueue.splice(i, 1);
        }
    }

    // Send "always" for the current (head) permission
    const toolUseId = currentPrompt.toolUseId || '';
    const card = document.getElementById('promptCard');
    card.classList.add('loading');
    navigator.vibrate?.(50);

    const msg = { action: 'inject', command: 'always', sessionId: currentSessionId };
    if (toolUseId) msg.toolUseId = toolUseId;
    const success = wsSend(msg);

    if (success) {
        trackSentMessage('always');
        appendMessage({ type: 'user', content: 'always' });
        if (settings.ttsEnabled) {
            speak('Approved all permissions');
        }
        setTimeout(() => hidePromptCard(), 300);
    } else {
        card.classList.remove('loading');
        showToast('Failed to send response', 'error');
    }
}
```

**3b.** In `showPromptCard()` permission case (~line 152-157), add the cross-tool "Approve All" button. Calculate `totalPermissionCount` (all permission types in queue + current) and show when > 1 and mixed tools:

```javascript
const totalPermissions = promptQueue.filter(p => p.type === 'permission').length + 1;
const hasMixedTools = totalPermissions > 1 && totalPermissions !== sameToolTotal;

// After existing allow-all button HTML:
${hasMixedTools ? `<button class="prompt-btn approve-all" data-action="approve-all">Approve All (${totalPermissions})</button>` : ''}
```

Attach handler programmatically (XSS-safe, per past learning):
```javascript
const approveAllBtn = actions.querySelector('[data-action="approve-all"]');
if (approveAllBtn) approveAllBtn.addEventListener('click', () => approveAllPermissions());
```

**3c.** Update `updateBatchButton()` to also update or add the "Approve All" button count when new permissions arrive.

### Step 4: Add tests (iOS)

**File:** `ClaudeRemote/Tests/ClaudeRemoteTests/PromptServiceTests.swift`

New test cases:
- **"approveAll sends always for head and clears all permissions"** — Queue 3 permissions (Bash, Write, Read), call `approveAll()`, verify: `inject` called once with head's toolUseId, queue is empty, all 3 tools in `allowedTools`
- **"approveAll preserves non-permission prompts"** — Queue 2 permissions + 1 question, call `approveAll()`, verify: question remains in queue
- **"approveAll clears pending permissions dict"** — Add pending permissions not yet flushed, call `approveAll()`, verify pending dict empty
- **"approveAll no-ops when head is not a permission"** — Queue a question as head, call `approveAll()`, verify nothing changes

### Step 5: Add tests (Node)

**File:** `test/prompts.test.js` (or appropriate web test file)

Test that `approveAllPermissions()`:
- Adds all tools to `alwaysAllowedTools`
- Removes all permission prompts from queue
- Preserves non-permission prompts in queue
- Sends correct WebSocket message

## Affected Files

- `ClaudeRemote/Sources/ClaudeRemote/Services/PromptService.swift` — Add `approveAll()` method
- `ClaudeRemote/Sources/ClaudeRemote/Views/Components/PromptCardView.swift` — Add "Approve All" button, pass `onApproveAll` + `totalPermissionCount` to `PermissionCardContent`
- `public/js/prompts.js` — Add `approveAllPermissions()`, update `showPromptCard()` and `updateBatchButton()`
- `ClaudeRemote/Tests/ClaudeRemoteTests/PromptServiceTests.swift` — New test cases
- `test/prompts.test.js` — New test cases (if web tests exist for prompts)

## Acceptance Criteria

- [ ] "Approve All (N)" button appears on iOS when 2+ permissions from different tools are queued
- [ ] "Approve All (N)" button appears on web client under same conditions
- [ ] Tapping "Approve All" sends exactly one "always" inject for the head permission
- [ ] All unique tools from queue+pending are added to `allowedTools`/`alwaysAllowedTools`
- [ ] All permission items are cleared from queue; non-permission items (questions, planExit) preserved
- [ ] Button does NOT appear when all queued permissions are the same tool (existing "Allow All [Tool]" handles that)
- [ ] `swift build` compiles, `swift test` passes
- [ ] `node --test test/*.test.js` passes
- [ ] Manual test: multi-agent session with mixed tool permissions → "Approve All" clears all in one tap

## Test Strategy

- **Unit tests (iOS):** approveAll() with mixed tools, with pending dict, preserving non-permissions, no-op on non-permission head
- **Unit tests (web):** approveAllPermissions() tool collection, queue cleanup, WS message
- **Edge cases:**
  - Empty queue (only head) — button shouldn't appear (count would be 1)
  - All same tool — button shouldn't appear (existing button covers this)
  - Head is a question, not permission — approveAll() should no-op
  - `pendingPermissions` has items not yet flushed — must be cleared too
  - Queue has mix of permissions + questions — only permissions removed

## Security Review

- [ ] N/A — not security-sensitive. No new external input processing. Reuses existing inject protocol. Tool names are already validated by server. Web button uses programmatic event handlers (not inline onclick) per XSS fix from past learnings.

## Past Learnings Applied

- **permission-queue-concurrent-subagents.md**: `cascadeAlwaysAllow` is the direct ancestor pattern. Must drain both `pendingPermissions` dict AND `promptQueue`. Double-dismissal prevention via single `dismissHead()` call.
- **parallel-agent-permission-queue-nuked-on-processing.md**: Must persist grants to `allowedTools` (iOS) / `alwaysAllowedTools` (web) client-side. Must implement in BOTH iOS and web for parity. Web needs explicit button re-render via `updateBatchButton()`.
- **xss-inline-onclick-tool-names.md**: Web client buttons must use programmatic `addEventListener` (not inline `onclick` with interpolated tool names). Already applied in Step 3b.

## Risks

- **Race with coalesce timer** — Low likelihood, low impact. If `approveAll()` is called while `coalesceTask` is pending, the pending permissions would flush after the queue is cleared. Mitigation: `approveAll()` explicitly cancels `coalesceTask` and clears `pendingPermissions` dict.
- **Claude Code doesn't honor cascaded "always"** — Low likelihood, low impact. If Claude Code prompts again for a tool we cascaded (but didn't send "always" for), the prompt would re-appear. Mitigation: `allowedTools` client-side set suppresses re-display; the server's `sessionGranted` will catch up when the next "always" is sent for that tool naturally.
- **Accidental approval of destructive operations** — Medium likelihood, medium impact. Users might tap "Approve All" without reviewing individual permissions. Mitigation: button is visually distinct (indigo), count is displayed, and individual cards remain visible for review before tapping. No confirmation dialog added to keep the flow fast (users who want caution can use individual buttons).
