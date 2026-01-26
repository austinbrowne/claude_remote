---
status: pending
priority: p2
issue_id: "030"
tags:
  - code-quality
  - code-review
  - cleanup
dependencies: []
---

# Dead Code: getITermTabNames() Never Called

## Problem Statement

The function `getITermTabNames()` (server.js lines 51-79) is defined but never called anywhere in the codebase. This is ~30 lines of dead code that adds maintenance burden.

**Why it matters**: Dead code creates confusion, increases cognitive load, and can mask bugs if someone assumes it's being used.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js` lines 51-79

```javascript
function getITermTabNames() {
  return new Promise((resolve) => {
    const script = `
      tell application "iTerm"
        set tabInfo to {}
        repeat with aWindow in windows
          repeat with aTab in tabs of aWindow
            set ttyName to tty of current session of aTab
            set tabName to name of aTab
            set end of tabInfo to {tty:ttyName, name:tabName}
          end repeat
        end repeat
        return tabInfo
      end tell
    `;
    exec(\`osascript -e '${script}'\`, (err, stdout) => {
      // ... parsing logic
    });
  });
}
```

**Evidence:**
- Grep for `getITermTabNames` returns only the function definition
- The code uses directory names instead (line 132: `const dirName = path.basename(proc.cwd)`)

## Proposed Solutions

### Option A: Delete the function (Recommended)
- Remove lines 51-79 entirely
- **Pros**: Clean code, no confusion
- **Cons**: None (it's unused)
- **Effort**: Trivial
- **Risk**: None

### Option B: Comment with TODO
- Add comment explaining why it's not used
- Keep for potential future use
- **Pros**: Preserves work
- **Cons**: Still dead code
- **Effort**: Trivial
- **Risk**: None

## Recommended Action

Option A - Delete the unused function.

## Technical Details

**Affected files:**
- `server.js:51-79` - function to remove

## Acceptance Criteria

- [ ] `getITermTabNames()` function removed
- [ ] No references to the function remain
- [ ] Server still starts and functions correctly

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-26 | Created | Identified during simplicity review |

## Resources

- Code simplicity reviewer agent finding
