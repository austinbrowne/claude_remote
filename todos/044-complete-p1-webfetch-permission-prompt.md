---
status: complete
priority: p1
issue_id: "044"
tags:
  - bug
  - permissions
  - security
dependencies: []
---

# WebFetch Requests Not Prompting for Approval

## Problem Statement

When Claude Code uses the WebFetch tool to fetch URLs, mobile app doesn't show a permission prompt. The request either silently proceeds or gets stuck waiting for input that never appears.

**Why it matters**: Security-sensitive operation (network requests) bypassing user approval.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js` - `parseLogEntry()`

**Current permission detection:**
```javascript
if (toolName === 'Bash' || toolName === 'Edit' || toolName === 'Write') {
  // Shows permission prompt
}
```

**Missing:** `WebFetch` not in the list of tools that trigger permission prompts.

## Proposed Solution

Add WebFetch to permission-triggering tools:

```javascript
if (toolName === 'Bash' || toolName === 'Edit' || toolName === 'Write' || toolName === 'WebFetch') {
  parsed.push({
    type: 'permission_request',
    tool: toolName,
    input: toolInput
  });
}
```

**Display format:**
```
┌─────────────────────────────────────┐
│ 🔐 Permission Request               │
│                                     │
│ Allow WebFetch?                     │
│ https://api.example.com/data        │
│                                     │
│     [Yes]        [No]               │
└─────────────────────────────────────┘
```

## Acceptance Criteria

- [ ] WebFetch requests show permission prompt
- [ ] URL clearly visible in prompt
- [ ] Can approve/deny from mobile
- [ ] Approved requests proceed correctly

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-27 | Created | User feedback - security issue |
