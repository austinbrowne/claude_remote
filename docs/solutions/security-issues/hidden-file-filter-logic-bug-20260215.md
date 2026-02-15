---
module: File API
date: 2026-02-15
problem_type: security_issue
component: controller
symptoms:
  - ".env file visible in directory listing via /api/files endpoint"
  - "Hidden files like .npmrc, .gitignore exposed to mobile clients"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [hidden-files, dotfiles, directory-listing, filter, env, security]
language: javascript
framework: express
---

# Troubleshooting: Hidden File Filter Only Excluded Directories, Not Files

## Problem
The `/api/files` endpoint filtered hidden entries with `.startsWith('.') && isDirectory()`, which only excluded hidden directories (like `.git/`) but allowed hidden files (like `.env`, `.npmrc`) to appear in listings.

## Environment
- Module: File API (server.js)
- Language/Framework: JavaScript / Express
- Affected Component: `GET /api/files` directory listing endpoint
- Date: 2026-02-15

## Symptoms
- `.env` file containing secrets visible in document viewer directory listing
- `.npmrc`, `.gitignore`, and other dotfiles appear alongside source files
- Only hidden directories (`.git`, `.build`) were filtered; hidden files passed through

## What Didn't Work

**Direct solution:** Caught during fresh-eyes-review by the Security Reviewer agent. The `&& dirent.isDirectory()` condition was the clear bug.

## Solution

Remove the `&& dirent.isDirectory()` condition so ALL hidden entries are filtered:

```javascript
// Before (broken) — only filtered hidden directories:
if (dirent.name.startsWith('.') && dirent.isDirectory()) continue;

// After (fixed) — filters all hidden entries:
if (dirent.name.startsWith('.')) continue;
```

## Why This Works

1. **Root cause:** The `&&` operator made the filter too narrow — it required BOTH conditions (starts with `.` AND is a directory). Hidden files like `.env` passed because they matched the first condition but not the second.
2. Dotfiles are hidden by convention on Unix systems. A directory listing endpoint should respect this convention to avoid exposing sensitive configuration files.
3. The `EXCLUDED_DIRS` set already handled specific directory exclusions (`.git`, `node_modules`), so the dotfile check only needed to handle the general case.

## Prevention

- When writing filter conditions with `&&`, verify each branch independently — "does this filter what I intend when only one condition is true?"
- Security review catches: always review file listing endpoints for information disclosure
- Consider an allowlist approach (only show known-safe file types) instead of a blocklist (hide known-bad patterns)
