---
module: Claude Remote iOS / Server Integration
date: 2026-02-05
problem_type: integration_issue
component: api_client
symptoms:
  - "ExitPlanMode prompt not displayed on iOS"
  - "Plan mode exits automatically without user consent"
  - "Binary y/n assumption for plan approval was incorrect"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [exitplanmode, plan-mode, ink-selector, selectOption, tui, arrow-keys, claude-code]
language: swift
framework: swiftui
issue_ref: "#9"
related_solutions:
  - permission-queue-concurrent-subagents.md
  - subagent-tool-flooding-and-task-id-mapping.md
---

# Claude Code ExitPlanMode Uses Ink-Based TUI Selector

## Problem

When implementing ExitPlanMode prompt handling for the iOS companion app, the initial plan assumed a binary y/n response format. Plan review and research revealed that ExitPlanMode actually presents **4 options** through an ink-based terminal UI selector that ignores typed text.

## Environment

- Claude Code CLI (any version with plan mode)
- Claude Remote iOS companion app
- Node.js server (WebSocket bridge)

## Symptoms

1. Initial plan proposed using `inject` action to send "y" or "n" responses
2. Plan review flagged that ExitPlanMode has 4 options, not 2
3. Research confirmed ExitPlanMode uses same ink-based TUI as AskUserQuestion

## What Didn't Work

**Approach 1: Text injection (`inject` action)**
- Claude Code's ink Select component ignores typed text
- Only arrow-key navigation works for option selection
- This is the same behavior as AskUserQuestion prompts

## Solution

Use `selectOption` action (arrow-down keys + Enter) instead of `inject`:

```swift
// PromptService.swift
public func respondPlanExit(_ option: PlanExitOption) {
    guard let sid = sessionId else { return }

    switch option {
    case .acceptPreserveContext:
        // Option 2 (0-indexed: 1) — preserves context
        sendHandler?(.selectOption(index: 1, sessionId: sid))
    case .acceptClearContext:
        // Option 1 (0-indexed: 0) — clears context (destructive)
        sendHandler?(.selectOption(index: 0, sessionId: sid))
    case .manualApprove:
        // Option 3 (0-indexed: 2) — manually approve each edit
        sendHandler?(.selectOption(index: 2, sessionId: sid))
    case .requestChanges(let text):
        // Option 4 (0-indexed: 3) — select text input, then inject
        sendHandler?(.selectOption(index: 3, sessionId: sid))
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(300))
            sendHandler?(.inject(command: text, sessionId: sid))
        }
    }
    dismissHead()
}
```

Server-side `selectOption` handler (already exists for AskUserQuestion):

```javascript
// server.js
function selectOptionInTty(index, tty) {
    // Rate limit check
    if (!commandRateLimit.check()) {
        return Promise.reject(new Error('Rate limit exceeded'));
    }

    // Build arrow-down commands for navigation
    const arrowCommands = [];
    for (let i = 0; i < index; i++) {
        arrowCommands.push('key code 125'); // Down arrow
    }
    arrowCommands.push('key code 36'); // Enter/Return

    // Execute via AppleScript
    const script = `tell application "iTerm" to tell session tty "${tty}" ...`;
    return exec(script);
}
```

## Why This Works

1. **Ink Select component**: Claude Code uses the `ink` npm package for terminal UI. The Select component only responds to arrow key navigation (up/down to move, Enter to select).

2. **Option indices are 0-based**: When navigating, index 0 = no arrow keys (first option), index 1 = one down arrow, etc.

3. **Text input for option 4**: The fourth option is a text input field. After selecting it with arrow keys + Enter, the field is focused and typed text is accepted via `inject`.

## ExitPlanMode Options

| Index | Option | Description |
|-------|--------|-------------|
| 0 | "Yes, clear context and auto-accept edits" | DEFAULT in Claude Code TUI (Shift+Tab). **DESTRUCTIVE** — clears conversation history |
| 1 | "Yes, auto-accept edits" | Preserves context. **RECOMMENDED** for iOS default |
| 2 | "Yes, manually approve edits" | Preserves context, requires manual approval for each edit |
| 3 | Free-form text input | User types modifications/requests |

## Gotchas

1. **Option 1 is destructive by default**: Claude Code's TUI defaults to option 1 (clear context). iOS app should default to option 2 to prevent accidental data loss.

2. **ExitPlanMode is main-agent-only**: Subagents don't have access to ExitPlanMode. No need to handle subagent attribution for this prompt type.

3. **VoicePromptMatcher must handle planExit**: Adding `.planExit` to `PromptKind` enum requires updating VoicePromptMatcher or the build will fail (exhaustive switch).

4. **Delay before text injection**: When selecting option 4, wait ~300ms before injecting text to allow the ink UI to focus the text field.

5. **Research before planning**: The initial plan was corrected during review. For interactive TUI prompts, always research the actual response mechanism (arrow keys vs text) before implementing.

## Prevention

- When implementing new Claude Code prompt types, verify:
  1. Does it use ink Select component? (arrow keys only)
  2. What are ALL the options? (not just yes/no)
  3. Which option is the default?
  4. Is text input involved?

- Use plan review with research validation before implementation

## Related Issues

- Issue #9: Fix ExitPlanMode to present question and process response
- GitHub Issue #18599 (anthropics/claude-code): Documents the 4 ExitPlanMode options

## References

- [Claude Code ExitPlanMode Tool Description](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-exitplanmode.md)
- [GitHub Issue #18599](https://github.com/anthropics/claude-code/issues/18599) — Feature request to change default option
