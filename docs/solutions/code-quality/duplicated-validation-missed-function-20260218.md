---
title: "Duplicated Validation Guards Lead to Missed Functions During Refactoring"
category: code-quality
subcategory: security
tags:
  - validation
  - duplication
  - refactoring
  - dry
  - injection-prevention
  - applescript
components:
  - lib/command-injection.js
symptoms:
  - injection-vulnerability
  - inconsistent-validation
severity: critical
date: 2026-02-18
---

# Duplicated Validation Guards Lead to Missed Functions During Refactoring

## Problem

During extraction of command-injection code from server.js into lib/command-injection.js, four functions all needed TTY format validation (`/^ttys\d+$/` regex). Three functions had the validation copy-pasted inline, but the fourth (`sendEscapeKeyToTty`) was missed entirely — creating an injection vector where unvalidated TTY strings were interpolated into AppleScript via `exec(osascript)`.

## Root Cause

The TTY validation regex was duplicated inline in each function rather than extracted into a shared helper. When adding a new function or refactoring, it's easy to miss one copy. The copy-paste pattern creates a maintenance trap: you have to remember to update N locations instead of 1.

## Fix

Extract a shared `validateTty(tty)` helper at module scope, called by all four TTY functions:

```javascript
function validateTty(tty) {
  if (!/^ttys\d+$/.test(tty)) {
    return new Error('Invalid TTY format');
  }
  return null;
}
```

Each function calls `validateTty(tty)` at the top. Adding new TTY functions automatically inherits the validation by calling the same helper.

## Key Insight

**Duplicated validation is a security liability.** When the same validation appears in N places, the probability of one being missed is proportional to N. During code review, the 4-agent fresh-eyes-review caught this because the security, code quality, edge case, and error handling reviewers all independently flagged `sendEscapeKeyToTty` as the odd function out.

## Prevention

- When writing input validation, always extract it into a named helper function
- During refactoring, grep for the validation pattern to find all call sites
- In code review, check that all functions in a family have consistent guards
- If you see a validation pattern copy-pasted 2+ times, extract it immediately

## Related

- Same pattern applied to `charCode` validation (integer 0-127) and `index` bounds (0-50) in the same module
- The `commandRateLimit.check()` call was also missing from `sendEscapeKeyToTty` for the same reason
