---
status: complete
priority: p1
issue_id: "048"
tags:
  - security
  - code-review
dependencies: []
---

# AppleScript Command Injection Risk

## Problem Statement

The `injectCommandToTty()` function has insufficient escaping when embedding user commands into AppleScript strings. Missing handling for newlines and control characters creates potential for AppleScript injection.

**Why it matters**: An authenticated attacker could potentially break out of the string context and execute arbitrary AppleScript commands.

## Findings

**Location:** `server.js:1303`

**Current escaping:**
```javascript
const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
```

**Missing:**
- Newlines (`\n`, `\r`) - could break AppleScript syntax
- Tab characters (`\t`)
- Other control characters

**OWASP Category:** A03 Injection

## Proposed Solutions

### Option A: Enhanced String Escaping (Recommended)
```javascript
function escapeForAppleScript(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}
```
- **Pros:** Minimal change, addresses the vulnerability
- **Cons:** May still miss edge cases
- **Effort:** Small
- **Risk:** Low

### Option B: Use Clipboard-Based Injection
Instead of embedding the command in AppleScript, copy to clipboard and paste.
- **Pros:** Eliminates string interpolation entirely
- **Cons:** Uses clipboard (could conflict with user clipboard)
- **Effort:** Medium
- **Risk:** Medium

## Acceptance Criteria

- [ ] All control characters properly escaped
- [ ] No way to break out of AppleScript string context
- [ ] Existing functionality unaffected

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-27 | Created | Security review finding |
