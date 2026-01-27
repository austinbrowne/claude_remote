---
title: "fix: Multi-select Input Injection"
type: fix
date: 2026-01-26
---

# Fix: Multi-select Input Injection for Claude Code

## Overview

The mobile app cannot properly submit multi-select answers to Claude Code's AskUserQuestion prompts. Current AppleScript-based keystroke injection fails due to race conditions and fundamental incompatibilities with how Ink (Claude Code's terminal UI framework) handles programmatic input.

## Problem Statement

When Claude Code asks a multi-select question (e.g., "Which features do you want?"), the mobile app attempts to:
1. Toggle each selected option by injecting its number + Enter
2. Send an empty Enter to submit

**What happens:** The terminal shows erratic toggling behavior - wrong options get selected/deselected, and the final submission doesn't work.

**Root cause:** Two compounding issues:
1. **Race condition:** Clipboard gets overwritten before paste completes
2. **Ink framework limitation:** Programmatic keystrokes may not trigger the same callbacks as physical keypresses

## Research Findings

### 1. Ink Framework Behavior

Claude Code uses [Ink](https://github.com/vadimdemedes/ink) with [ink-multi-select](https://github.com/karaggeorge/ink-multi-select) for terminal UI. The multi-select component expects:

| Action | Key |
|--------|-----|
| Navigate | Arrow Up/Down or j/k |
| Toggle selection | Space |
| Submit | Enter |

**Critical finding:** According to [GitHub Issue #15553](https://github.com/anthropics/claude-code/issues/15553), Ink may differentiate between physical Enter keypresses and programmatic `\r`/`\n` characters. Physical Enter triggers `onSubmit`, while programmatic newlines may be treated as literal characters.

### 2. Current Injection Method

The server uses this AppleScript approach:
```applescript
tell application "iTerm" to activate
delay 0.15
tell application "System Events" to tell process "iTerm2"
  keystroke "v" using command down  -- Paste from clipboard
  delay 0.1
  keystroke return
end tell
```

**Problems identified:**
- Fixed delays (0.15s, 0.1s) are arbitrary and may not allow enough time
- No feedback loop - server doesn't know if iTerm processed the input
- Clipboard can be overwritten before paste completes
- `keystroke return` may not be equivalent to physical Enter for Ink

### 3. Hook Support Status

- [Issue #12605](https://github.com/anthropics/claude-code/issues/12605) (AskUserQuestion Hook Support) is marked **CLOSED/COMPLETED** but implementation details unclear
- [Issue #13830](https://github.com/anthropics/claude-code/issues/13830) requests notification hooks for AskUserQuestion events - still **OPEN**
- [Issue #15872](https://github.com/anthropics/claude-code/issues/15872) requests hook support for AskUserQuestion - still **OPEN**
- Current `Notification` hook has `elicitation_dialog` matcher for MCP tools, but NOT for AskUserQuestion

**Conclusion:** No reliable hook-based solution exists for programmatically answering AskUserQuestion prompts.

## Proposed Solutions

### Option A: Raw Terminal Escape Sequences (Recommended)

Instead of AppleScript clipboard/paste, send raw escape sequences directly to the terminal via `tmux send-keys` or direct PTY write.

**Approach:**
1. Run Claude Code inside tmux (or screen)
2. Use `tmux send-keys` to inject characters and escape sequences
3. Send proper key codes: Space for toggle, Enter for submit

```bash
# Toggle option 1
tmux send-keys -t session:window '1'
tmux send-keys -t session:window Enter
sleep 0.5

# Toggle option 3
tmux send-keys -t session:window '3'
tmux send-keys -t session:window Enter
sleep 0.5

# Submit (empty Enter)
tmux send-keys -t session:window Enter
```

**Pros:**
- More reliable than AppleScript
- Proper key event simulation
- Works with raw terminal mode

**Cons:**
- Requires Claude Code to run in tmux
- Changes workflow for users

### Option B: Increase Delays + Wait for Echo (Quick Fix)

Keep AppleScript approach but add verification.

**Approach:**
1. Increase delay between injections to 1000ms
2. After each injection, verify the text appeared in the terminal output
3. Only proceed when previous command is confirmed

```javascript
async function injectWithVerification(command, expectedEcho) {
  await injectCommand(command);
  await waitForTerminalEcho(expectedEcho, timeout: 2000);
}
```

**Pros:**
- Minimal code changes
- No workflow changes for users

**Cons:**
- May still fail due to Ink's input handling
- Slower user experience
- Requires parsing terminal output

### Option C: Alternative Input Method - "Other" Freeform

**Approach:**
1. For multi-select questions, always use the "Other" freeform input option
2. Send the selection as text: "1, 3" or "options 1 and 3"
3. Claude interprets the text response

**Pros:**
- Simple, reliable text injection
- Works with existing AppleScript method
- No timing issues

**Cons:**
- Depends on Claude interpreting freeform text correctly
- May not work for all question types
- Loses structured selection benefit

### Option D: Hybrid - Single Selection Fallback

**Approach:**
1. Detect multi-select prompts on mobile
2. Force single selection mode on mobile UI
3. User selects ONE option, which works reliably
4. Show toast: "Multi-select not supported on mobile - select one option"

**Pros:**
- Guaranteed to work
- Clear user expectation
- No complex timing logic

**Cons:**
- Reduced functionality
- User must repeat if multiple answers needed

## Recommended Approach

**Phase 1: Quick Fix (Option B + D hybrid)**
1. Increase injection delay to 800ms
2. Add verification by watching for terminal echo
3. If multi-select fails after 3 retries, fall back to single-select with user notification

**Phase 2: Proper Fix (Option A)**
1. Document requirement to run Claude Code in tmux
2. Implement tmux send-keys injection method
3. Provide `start.sh` script that wraps Claude in tmux

## Implementation Plan

### Phase 1: Quick Fix

- [ ] **server.js** - Add terminal output monitoring to detect injection success
- [x] **server.js** - Increase AppleScript delays from 0.15s to 0.4s
- [x] **index.html** - Change `injectAndWait` timeout from 3s to 5s
- [x] **index.html** - Add retry logic (3 attempts) in `submitChoice`
- [x] **index.html** - Add "Multi-select may be unreliable" warning toast
- [x] **index.html** - Fallback to single-select if retries exhausted

### Phase 2: tmux Integration

- [ ] **server.js** - Add tmux detection (`tmux has-session`)
- [ ] **server.js** - Implement `injectViaTmux(command)` function
- [ ] **server.js** - Auto-select injection method based on environment
- [ ] **start-claude.sh** - Create wrapper script to launch Claude in tmux
- [ ] **README.md** - Document tmux requirement for reliable multi-select

## Files to Modify

| File | Changes |
|------|---------|
| `server.js:828-867` | Modify `injectCommand` delays, add verification |
| `server.js:NEW` | Add `injectViaTmux` function |
| `public/index.html:2294-2319` | Update `submitChoice` with retry logic |
| `public/index.html:1091-1110` | Modify `injectAndWait` timeout |

## Acceptance Criteria

- [x] Multi-select prompts reliably toggle correct options
- [x] Submission (empty Enter) is processed correctly
- [x] User sees clear feedback if multi-select fails
- [x] Single-select continues to work flawlessly
- [x] No regression in other injection functionality

## Verification

1. Start server, connect from mobile
2. Ask Claude a multi-select question
3. Select options 1 and 3 on mobile
4. Tap Submit
5. Verify terminal shows options 1 and 3 selected
6. Verify Claude receives the correct answer

## References

### Internal
- `server.js:828-867` - Current injectCommand implementation
- `public/index.html:2294-2319` - Current submitChoice implementation

### External
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [ink-multi-select GitHub](https://github.com/karaggeorge/ink-multi-select)
- [Claude Code Issue #12605 - AskUserQuestion Hook Support](https://github.com/anthropics/claude-code/issues/12605)
- [Claude Code Issue #13830 - Notification Hook for AskUserQuestion](https://github.com/anthropics/claude-code/issues/13830)
- [Claude Agent SDK - User Input Handling](https://platform.claude.com/docs/en/agent-sdk/user-input)
