# Terminal Injection Best Practices

Prevention strategies for AppleScript/iTerm automation bugs, particularly clipboard race conditions and Ink terminal UI compatibility.

## Table of Contents

1. [Prevention Checklist](#prevention-checklist)
2. [AppleScript/iTerm Automation Best Practices](#applescriptiterm-automation-best-practices)
3. [Ink Framework Considerations](#ink-framework-considerations)
4. [Test Scenarios](#test-scenarios)
5. [Warning Signs](#warning-signs)

---

## Prevention Checklist

Use this checklist when implementing or reviewing terminal injection features.

### Before Writing Code

- [ ] **Identify the target UI framework** - Is the target application using raw readline, Ink, blessed, or another TUI framework?
- [ ] **Check submission requirements** - Does the UI require Enter, Tab+Enter, Space, or other key combinations?
- [ ] **Determine input mode** - Is the terminal in cooked mode (line buffered) or raw mode (character-by-character)?
- [ ] **Assess timing requirements** - Does the target process input synchronously or asynchronously?

### Clipboard Operations

- [ ] **Never assume clipboard atomicity** - The clipboard is a shared system resource that can be modified by any application at any time
- [ ] **Avoid rapid clipboard operations** - Do not send multiple clipboard-based injections in quick succession
- [ ] **Use direct keystroke injection for short inputs** - For single characters or short strings (<=1 char), use `keystroke` directly instead of clipboard
- [ ] **Consider clipboard preservation** - If preserving user clipboard is important, save and restore it (with appropriate delays)

### Timing and Delays

- [ ] **Add delay after `activate`** - The `activate` command is asynchronous; subsequent commands may execute before the app is ready
- [ ] **Add delay after paste** - Clipboard paste operations are not instantaneous
- [ ] **Add delay before submission** - Terminal applications may buffer input; allow processing time
- [ ] **Use conservative delays** - Start with 400ms+ delays; optimize down only after thorough testing
- [ ] **Consider network latency** - If controlling remote terminals, add additional buffer time

### Input Verification

- [ ] **Implement echo verification** - After injection, verify the expected text appeared in terminal output
- [ ] **Add retry logic** - Transient failures are common; implement 2-3 retries before failing
- [ ] **Provide user feedback** - Show progress indicators during multi-step injections
- [ ] **Graceful degradation** - Fall back to simpler input methods if complex injection fails

### Multi-Select/Complex Inputs

- [ ] **Never assume Enter submits** - Many TUI frameworks require Tab+Enter, Space+Enter, or other combinations
- [ ] **Test each selection independently** - Verify toggle state after each selection
- [ ] **Allow sufficient inter-selection delays** - 800-1000ms between selections is safer than 100-200ms
- [ ] **Handle partial success** - If 3 of 5 selections work, provide clear feedback about what succeeded/failed

---

## AppleScript/iTerm Automation Best Practices

### DO: Use Appropriate Injection Methods

```applescript
-- For short inputs (<=1 char): Direct keystroke (avoids clipboard race)
tell application "System Events" to tell process "iTerm2"
  keystroke "1"
  delay 0.2
  keystroke return
end tell

-- For longer inputs: Clipboard with adequate delays
-- 1. Copy to clipboard
-- 2. Activate application with delay
-- 3. Paste with delay
-- 4. Submit with delay
```

### DO: Use Conservative Delays

```applescript
-- Good: Conservative delays account for system variability
tell application "iTerm" to activate
delay 0.4  -- Wait for window focus
tell application "System Events" to tell process "iTerm2"
  keystroke "v" using command down
  delay 0.3  -- Wait for paste completion
  keystroke return
end tell
```

```applescript
-- Bad: Minimal delays assume ideal conditions
tell application "iTerm" to activate
delay 0.1
tell application "System Events" to tell process "iTerm2"
  keystroke "v" using command down
  delay 0.05
  keystroke return
end tell
```

### DO: Use Key Codes for Special Keys

```applescript
-- Key codes are more reliable than named keys
tell application "System Events" to tell process "iTerm2"
  key code 48  -- Tab
  delay 0.2
  key code 36  -- Return/Enter
end tell
```

| Key | Key Code |
|-----|----------|
| Tab | 48 |
| Return | 36 |
| Escape | 53 |
| Space | 49 |
| Delete | 51 |
| Up Arrow | 126 |
| Down Arrow | 125 |
| Left Arrow | 123 |
| Right Arrow | 124 |

### DON'T: Assume GUI Scripting Is Synchronous

The `activate` command and GUI scripting commands may complete before the target application is ready to receive input. This is the root cause of most race conditions.

### DON'T: Ignore Permission Issues

Accessibility permissions can expire or be revoked. Implement graceful handling:

```javascript
// Check for permission errors
if (stderr.includes('not allowed to send keystrokes')) {
  throw new Error('Accessibility permission required. Check System Preferences > Privacy > Accessibility');
}
```

### Alternative: iTerm2 Python API

For more reliable automation, consider using iTerm2's native Python API instead of AppleScript:

```python
import iterm2

async def main(connection):
    app = await iterm2.async_get_app(connection)
    window = app.current_window
    if window is not None:
        session = window.current_tab.current_session
        await session.async_send_text("your command here\n")

iterm2.run_until_complete(main)
```

**Pros:**
- No clipboard race conditions
- Proper escape sequence handling
- More reliable than GUI scripting

**Cons:**
- Requires Python runtime
- Security considerations (API must be enabled)
- More complex setup

### Alternative: tmux send-keys

For maximum reliability, run target applications inside tmux:

```bash
# Send text directly to terminal
tmux send-keys -t session:window "text to inject"

# Send Enter key
tmux send-keys -t session:window Enter

# Send special keys with proper timing
tmux send-keys -t session:window Escape
sleep 0.1  # Required delay after Escape
tmux send-keys -t session:window "i"
```

**Special Key Names for tmux:**
- `Enter` - Submit/newline
- `Escape` - Escape key
- `Space` - Space character
- `Tab` - Tab key
- `BSpace` - Backspace
- `Up`, `Down`, `Left`, `Right` - Arrow keys

---

## Ink Framework Considerations

Claude Code uses [Ink](https://github.com/vadimdemedes/ink), a React-based terminal UI framework. This creates specific challenges for programmatic input.

### Ink Input Handling Differences

| Input Type | Physical Keypress | Programmatic `\n` |
|------------|-------------------|-------------------|
| Submit | Triggers `onSubmit` | May be treated as literal character |
| Selection | Works reliably | May not trigger state update |
| Navigation | Works reliably | Usually works |

### Multi-Select Component Requirements

The `ink-multi-select` component expects:

| Action | Expected Key |
|--------|-------------|
| Navigate | Arrow Up/Down or j/k |
| Toggle selection | Space or number+Enter |
| Submit | Enter (when focused) or Tab+Enter |

**Critical:** Programmatic `\r` or `\n` characters may not trigger the same callbacks as physical Enter keypresses.

### Workarounds for Ink Limitations

1. **Use Tab+Enter for submission** - More reliable than Enter alone:
   ```applescript
   key code 48  -- Tab
   delay 0.2
   key code 36  -- Return
   ```

2. **Toggle with number keys** - Send the option number followed by Enter to toggle:
   ```javascript
   await inject("1");  // Toggle option 1
   await delay(1000);
   await inject("3");  // Toggle option 3
   await delay(1000);
   await inject("");   // Submit with Tab+Enter
   ```

3. **Use freeform input** - If available, type selections as text ("options 1 and 3") rather than toggling

---

## Test Scenarios

### Unit Tests for Injection Functions

```javascript
describe('injectCommand', () => {
  describe('short commands (<=1 char)', () => {
    it('should use direct keystroke for single digits', async () => {
      // Verify clipboard is not used
      // Verify keystroke is sent directly
    });

    it('should use key code 48 + return for empty string (Tab+Enter)', async () => {
      // Verify Tab is sent before Enter for submission
    });
  });

  describe('long commands (>1 char)', () => {
    it('should copy to clipboard before injection', async () => {
      // Verify pbcopy receives the command
    });

    it('should wait for clipboard before pasting', async () => {
      // Verify delay between copy and paste
    });
  });
});
```

### Integration Tests

```javascript
describe('Multi-select injection', () => {
  it('should toggle options in correct order', async () => {
    // 1. Start Claude with a multi-select prompt
    // 2. Inject selection "1", wait, verify option 1 is toggled
    // 3. Inject selection "3", wait, verify option 3 is toggled
    // 4. Inject empty (Tab+Enter), verify submission
  });

  it('should handle rapid successive injections gracefully', async () => {
    // Verify that even with minimal delays, no options are skipped
  });

  it('should retry on transient failure', async () => {
    // Simulate clipboard race, verify retry succeeds
  });
});
```

### Manual Test Scenarios

| Scenario | Steps | Expected Result |
|----------|-------|-----------------|
| Single selection | Select one option, submit | Option is selected and submitted |
| Multi-selection (2 items) | Select options 1 and 3, submit | Both options are toggled, submission works |
| Multi-selection (5+ items) | Select 5 options, submit | All options are toggled in order |
| Clipboard conflict | Copy something to clipboard during injection | Injection still succeeds (or fails gracefully) |
| Slow network | Run over SSH with latency | Increased delays handle latency |
| Permission revoked | Remove accessibility permissions mid-session | Clear error message, graceful failure |

### Stress Tests

```javascript
describe('Injection reliability', () => {
  it('should succeed 95%+ over 100 trials', async () => {
    let successes = 0;
    for (let i = 0; i < 100; i++) {
      try {
        await inject("test");
        successes++;
      } catch (e) {
        console.log(`Trial ${i} failed: ${e.message}`);
      }
      await delay(500);  // Reset between trials
    }
    expect(successes).toBeGreaterThanOrEqual(95);
  });
});
```

---

## Warning Signs

Watch for these indicators of injection problems during development and testing.

### Symptoms of Clipboard Race Conditions

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| Wrong text appears | Clipboard overwritten before paste | Increase delay, use direct keystroke |
| Partial text appears | Paste interrupted | Increase post-paste delay |
| Text appears twice | Paste executed twice | Add deduplication or acknowledgment |
| No text appears | Paste failed silently | Add error handling, check permissions |

### Symptoms of Timing Issues

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| First command works, subsequent fail | Insufficient inter-command delay | Increase delays between commands |
| Works on fast machine, fails on slow | Hardcoded delays too short | Use dynamic or conservative delays |
| Intermittent failures | Race condition | Add verification/retry logic |
| Works in development, fails in production | Different system load | Use more conservative delays |

### Symptoms of Ink Framework Issues

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| Enter doesn't submit | Ink expects Tab+Enter | Send Tab before Enter |
| Selections don't toggle | Programmatic input not triggering callbacks | Use number+Enter instead of Space |
| UI doesn't update | React state not re-rendering | Allow more time for state updates |
| Random options selected | Input being processed incorrectly | Slow down, verify after each step |

### Red Flags in Code Review

Look for these patterns that indicate potential injection bugs:

```javascript
// Red flag: Hardcoded short delays
delay 0.1  // Too short for reliability

// Red flag: No error handling
exec(`osascript -e '${script}'`);  // Silent failure

// Red flag: Assuming clipboard is safe
pbcopy.stdin.write(command);
// ... immediately paste without verification

// Red flag: No retry logic
if (failed) throw error;  // Single attempt only

// Red flag: Assuming Enter submits
keystroke return  // May not work for Ink UIs

// Red flag: Sequential clipboard operations without delays
await inject("1");
await inject("2");  // Clipboard race!
await inject("3");
```

### Defensive Patterns to Use

```javascript
// Good: Conservative delays
const SAFE_DELAY_MS = 1000;

// Good: Retry logic
async function injectWithRetry(command, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await inject(command);
      return;
    } catch (e) {
      if (attempt === maxRetries - 1) throw e;
      await delay(SAFE_DELAY_MS);
    }
  }
}

// Good: Direct keystroke for short inputs
if (command.length <= 1) {
  return injectDirect(command);
}

// Good: Tab+Enter for submission
if (command === '') {
  return injectTabEnter();
}

// Good: Verification after injection
await inject(command);
await waitForEcho(command, timeout);
```

---

## References

### Internal Documentation
- `/Users/austin/Git_Repos/claude_remote/server.js:828-908` - Current injection implementation
- `/Users/austin/Git_Repos/claude_remote/docs/plans/2026-01-26-fix-multiselect-input-injection-plan.md` - Detailed problem analysis

### External Resources
- [AppleScript Key Codes Reference](https://dougscripts.com/itunes/itinfo/keycodes.php)
- [iTerm2 Python API Documentation](https://iterm2.com/python-api/)
- [iTerm2 Scripting Fundamentals](https://iterm2.com/documentation-scripting-fundamentals.html)
- [tmux send-keys Guide](https://linuxhint.com/tmux-send-keys/)
- [tmux Special Key Names](https://gist.github.com/stephancasas/1c82b66be1ea664c2a8f18019a436938)
- [Ink Framework (Terminal UI)](https://github.com/vadimdemedes/ink)
- [ink-multi-select Component](https://github.com/karaggeorge/ink-multi-select)
- [How to Automate Your Keyboard with AppleScript](https://eastmanreference.com/how-to-automate-your-keyboard-in-mac-os-x-with-applescript)

### Known Issues
- [Claude Code Issue #12605 - AskUserQuestion Hook Support](https://github.com/anthropics/claude-code/issues/12605)
- [Claude Code Issue #13830 - Notification Hook for AskUserQuestion](https://github.com/anthropics/claude-code/issues/13830)
