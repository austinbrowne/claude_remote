---
status: pending
priority: p2
issue_id: "043"
tags:
  - feature
  - mobile-ui
  - status
dependencies: []
---

# Show Status Verbs and Token Usage While Working

## Problem Statement

Claude Code terminal shows status indicators while working:
- "Thinking..."
- "Reading files..."
- "Writing code..."
- Token usage counters (input/output tokens)

Mobile app has no equivalent - user can't tell if Claude is working or stuck.

**Why it matters**: No feedback loop during long operations leaves user uncertain.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html`

**Available in logs:**
- `type: "progress"` entries with status text
- `usage` field in assistant messages with token counts

**Current state:**
- Status verbs not parsed or displayed
- Token usage not tracked or shown

## Proposed Solution

Add status bar below header:

```
┌─────────────────────────────────────┐
│ 🔄 Reading server.js...             │
│ Tokens: 45.2k in / 8.1k out         │
└─────────────────────────────────────┘
```

**Implementation:**
1. Parse `progress` entries for status text
2. Accumulate token usage from `usage` fields
3. Show persistent status bar when session active
4. Update in real-time as logs stream

## Acceptance Criteria

- [ ] Status verb shown while Claude is working
- [ ] Token usage (input/output) displayed and updating
- [ ] Status clears when Claude finishes/waits for input
- [ ] Works for both main session and subagents

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-27 | Created | User feedback |
