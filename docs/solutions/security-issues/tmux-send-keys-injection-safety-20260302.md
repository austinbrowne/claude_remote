---
module: "command-injection"
date: 2026-03-02
problem_type: security_issue
component: tooling
symptoms:
  - "Shell injection possible when using exec() with tmux send-keys"
  - "tmux key-name interpretation turns literal text into keystrokes"
  - "Pipe characters in paths corrupt tmux list-panes output parsing"
  - "Concurrent inject sequences interleave without per-pane mutex"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [tmux, send-keys, execFile, command-injection, shell-injection, literal-mode, per-pane-mutex, pipe-delimiter]
language: javascript
framework: node
---

# tmux send-keys injection safety and parsing gotchas

## Problem

When porting a macOS/iTerm command injection system (AppleScript-based) to Linux using tmux, three security and correctness issues arise:

1. **Shell injection via exec()**: Using `exec(\`tmux send-keys -t ${paneId} "${text}"\`)` passes through the shell, allowing metacharacters (`;`, `$()`, backticks) in user input to execute arbitrary commands.
2. **Key-name interpretation**: tmux `send-keys` interprets strings like "Enter", "Escape", "C-c" as special keys by default, not literal text.
3. **Output parsing corruption**: `tmux list-panes -F` output split on `|` breaks when `pane_current_path` contains a literal pipe character.

## Environment

- Node.js 22+ on Linux (Fedora 43)
- tmux 3.2+
- Replacing AppleScript (`osascript`) + iTerm2 with tmux `send-keys`

## Symptoms

- User-controlled text injected into tmux pane could execute arbitrary shell commands
- Text containing "Enter" or "Escape" triggered actual keystrokes instead of being typed literally
- Sessions in directories with `|` in the name were misidentified or silently dropped

## What Didn't Work

- `exec(\`tmux send-keys -t ${paneId} "${text}"\`)` — shell interprets metacharacters
- `send-keys` without `-l` flag — tmux interprets key names in text payload
- `line.split('|')` with destructuring — last field (path) truncated at first `|`

## Solution

### 1. Use execFile with argument arrays (no shell)

```javascript
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// CORRECT: No shell involved — arguments passed as array
await execFileAsync('tmux', ['send-keys', '-t', paneId, '-l', text]);

// WRONG: Shell interprets metacharacters
exec(`tmux send-keys -t ${paneId} "${text}"`); // NEVER DO THIS
```

### 2. Use -l (literal) flag for text, separate call for keys

```javascript
// Text input: -l flag prevents key-name interpretation
await execFileAsync('tmux', ['send-keys', '-t', paneId, '-l', sanitizedText]);
// Submit: separate call without -l — Enter IS a key name here
await execFileAsync('tmux', ['send-keys', '-t', paneId, 'Enter']);
```

### 3. Fix pipe-delimited tmux output parsing

```javascript
// tmux format: #{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}
const parts = line.split('|');
const paneId = parts[0];
const pid = parts[1];
const currentCommand = parts[2];
const currentPath = parts.slice(3).join('|'); // Rejoin — path may contain '|'
```

### 4. Per-pane mutex for multi-step sequences

```javascript
const paneQueues = new Map();

function withPaneLock(paneId, fn) {
  const prev = paneQueues.get(paneId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  paneQueues.set(paneId, run.catch(() => {}));
  return run;
}

// Usage: prevents text1/text2/Enter1/Enter2 interleaving
async function injectCommand(command, paneId) {
  return withPaneLock(paneId, async () => {
    await tmuxSendKeys(paneId, '-l', sanitized);
    await delay(10);
    await tmuxSendKeys(paneId, 'Enter');
  });
}
```

### 5. Always add timeout to execFile

```javascript
await execFileAsync('tmux', ['send-keys', '-t', paneId, ...args], {
  timeout: 5000, // Prevent hung tmux from blocking indefinitely
});
```

## Why This Works

- **execFile** bypasses the shell entirely — arguments are passed directly to the process as an argv array
- **-l flag** tells tmux to treat the entire string as literal characters, not key names
- **slice(3).join('|')** captures everything after the third delimiter as a single value
- **withPaneLock** chains promises per pane ID so concurrent callers serialize instead of interleaving
- **timeout** ensures a stuck tmux process doesn't block the Node.js event loop indefinitely

## Prevention

- Always use `execFile` (not `exec`) when constructing commands from user input
- Validate pane IDs with strict regex (`/^%\d+$/`) before any tmux call
- Sanitize command text: strip control characters, enforce max length
- Add timeout to all child process calls
- Test with adversarial input: semicolons, backticks, pipe chars in paths
- Log tmux errors server-side; return generic messages to clients

## Related Issues

- AppleScript clipboard race condition (macOS) — different injection surface, same category
- Per-pane mutex missing from initial implementation — caught by concurrency review agent
