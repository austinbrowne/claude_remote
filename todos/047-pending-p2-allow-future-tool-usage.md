---
status: pending
priority: p2
issue_id: "047"
tags:
  - feature
  - permissions
  - mobile-ui
dependencies: []
---

# Can't "Always Allow" Tool/Action from Mobile

## Problem Statement

Claude Code terminal has "Always allow" option for permission prompts that remembers the choice for future uses of the same tool/action. Mobile app only has Yes/No - no way to approve future uses.

**Why it matters**: User must repeatedly approve the same safe operations, slowing down workflow.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html`

**Current permission card:**
```
┌─────────────────────────────────────┐
│ 🔐 Permission Request               │
│                                     │
│ Allow Bash?                         │
│ $ npm test                          │
│                                     │
│     [Yes]        [No]               │
└─────────────────────────────────────┘
```

**Missing:** "Always allow" option

**Claude Code terminal options:**
- Yes (once)
- No
- Always allow this tool
- Always allow this specific command pattern

## Proposed Solution

Add "Always Allow" button to permission card:

```
┌─────────────────────────────────────┐
│ 🔐 Permission Request               │
│                                     │
│ Allow Bash?                         │
│ $ npm test                          │
│                                     │
│ [Yes]  [Always Allow]  [No]         │
└─────────────────────────────────────┘
```

**Implementation:**
1. Add third button to permission card UI
2. Send different response to terminal:
   - "Yes" → `y` or `1`
   - "Always Allow" → `!` or appropriate key for "always allow"
   - "No" → `n` or `2`
3. Claude Code handles the persistence of the allow rule

**Note:** The actual "always allow" keystroke needs to be verified against Claude Code's Ink UI.

## Acceptance Criteria

- [ ] "Always Allow" button visible on permission prompts
- [ ] Clicking sends correct keystroke to enable future auto-approval
- [ ] Subsequent same-tool requests auto-approve (no prompt)
- [ ] Works for Bash, Edit, Write, WebFetch, MCP tools

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-27 | Created | User feedback |
