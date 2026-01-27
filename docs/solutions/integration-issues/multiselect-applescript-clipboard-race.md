---
title: "Multi-select AppleScript injection fails due to clipboard race conditions"
category: integration-issues
module: server/command-injection
severity: high
date_resolved: 2026-01-26
tags:
  - applescript
  - clipboard
  - race-condition
  - multi-select
  - iterm
  - ink-framework
  - keystroke-injection
  - askuserquestion
  - mobile-ui
symptoms:
  - "Erratic option toggling when submitting multi-select answers from mobile"
  - "Wrong options get selected/deselected in terminal"
  - "Final submission does not work after toggling options"
  - "Clipboard contents overwritten before paste completes"
related_issues:
  - "anthropics/claude-code#15553"
  - "anthropics/claude-code#12605"
  - "anthropics/claude-code#13830"
commits:
  - "8ef3fa5"
  - "9c6feba"
  - "85d782d"
---

# Multi-select AppleScript Injection Fails Due to Clipboard Race Conditions

## Problem

When using the Claude Remote mobile app to answer multi-select AskUserQuestion prompts, the terminal showed erratic behavior:
- Wrong options being selected/deselected
- Final submission not working
- Options toggling unpredictably

## Root Cause

**Two compounding issues:**

### 1. Clipboard Race Condition

The original `injectCommand()` function used clipboard-based paste:
```javascript
// PROBLEMATIC: Clipboard can be overwritten before paste completes
const pbcopy = exec('pbcopy', ...);
pbcopy.stdin.write(command);
// Then AppleScript: keystroke "v" using command down
```

When sending multiple selections quickly (e.g., "1", then "3"), the second `pbcopy` would overwrite the clipboard before the first paste completed.

### 2. Ink Framework Submit Behavior

Claude Code uses [Ink](https://github.com/vadimdemedes/ink) with `ink-multi-select` for its terminal UI. The Submit button must be **highlighted with Tab** before Enter will submit. Simply pressing Enter alone doesn't work.

## Solution

### 1. Direct Keystroke Injection for Short Commands

Added `injectCommandDirect()` that uses AppleScript `keystroke` directly instead of clipboard:

```javascript
// server.js - New function for single-character inputs
function injectCommandDirect(command) {
  return new Promise((resolve, reject) => {
    const escaped = command.replace(/"/g, '\\"');

    const appleScript = command.length === 0
      ? `
        tell application "iTerm" to activate
        delay 0.3
        tell application "System Events" to tell process "iTerm2"
          key code 48
          delay 0.2
          keystroke return
        end tell
      `
      : `
        tell application "iTerm" to activate
        delay 0.3
        tell application "System Events" to tell process "iTerm2"
          keystroke "${escaped}"
          delay 0.2
          keystroke return
        end tell
      `;

    exec(`osascript -e '${appleScript}'`, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}
```

**Key insight:** `key code 48` is Tab - this highlights the Submit button before Enter.

### 2. Route Short Commands to Direct Injection

```javascript
// server.js - Modified injectCommand()
function injectCommand(command) {
  // For short commands (single digits, empty), use direct keystroke
  if (command.length <= 1) {
    return injectCommandDirect(command);
  }
  // Use clipboard for longer text...
}
```

### 3. Increased Delays Between Selections

```javascript
// public/index.html - submitChoice()
for (let i = 0; i < values.length; i++) {
  showToast(`Selecting option ${values[i]}...`, 'info');
  await injectAndWait(values[i]);
  // Long delay to ensure terminal processes the keystroke
  await new Promise(r => setTimeout(r, 1000));
}
// Final Tab+Enter to submit
await injectAndWait('');  // Empty string triggers Tab+Enter
```

## Key Learnings

| Issue | Solution |
|-------|----------|
| Clipboard race condition | Use direct keystroke for short inputs |
| Ink Submit button focus | Send Tab (key code 48) before Enter |
| Timing issues | 1-second delays between selections |
| Empty string special case | Route to Tab+Enter submission |

## AppleScript Key Codes Reference

| Key | Code | Usage |
|-----|------|-------|
| Tab | 48 | Focus Submit button |
| Return | 36 | Or use `keystroke return` |
| Escape | 53 | Cancel dialogs |

## Prevention Checklist

When implementing terminal injection features:

- [ ] Identify if target uses Ink (requires Tab+Enter)
- [ ] Use direct keystroke for single characters
- [ ] Reserve clipboard for multi-character strings only
- [ ] Add 300-400ms delays after activate and paste
- [ ] Test with rapid sequential commands
- [ ] Implement retry logic for reliability

## Files Changed

- `server.js:828-909` - Added `injectCommandDirect()`, modified `injectCommand()` routing
- `public/index.html:2349-2383` - Updated `submitChoice()` with delays and progress toasts

## Related Documentation

- [Multi-select Fix Plan](../plans/2026-01-26-fix-multiselect-input-injection-plan.md)
- [Structured Prompt Detection Plan](../plans/2026-01-25-feat-structured-prompt-detection-plan.md)
