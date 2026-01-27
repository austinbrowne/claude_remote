---
status: pending
priority: p2
issue_id: "042"
tags:
  - feature
  - subagents
  - mobile-ui
dependencies: []
---

# Show Subagent Names, Tools, and Token Usage

## Problem Statement

The subagent indicator currently only shows a count badge (e.g., "🤖 2"). Users can't see:
1. **Subagent names/descriptions** - Only see hex IDs like "a343ba1"
2. **Tools being used** - No visibility into what each subagent is doing
3. **Token usage** - No metrics on subagent consumption

**Why it matters**: During multi-agent tasks (like code reviews), users have no insight into what's happening.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html`

**Current state:**
- `activeSubagents` Map stores: `{ status, startTime, description, lastActivity }`
- Description is always empty - never extracted from logs
- Tool usage not tracked
- Token usage not parsed from log entries

**Available in Claude Code logs:**
- Subagent description from Task tool invocation
- Tool calls with names and arguments
- Token usage in `usage` field of log entries

## Proposed Solutions

### Option A: Enhanced subagent panel (Recommended)

```
┌─────────────────────────────────────┐
│ 🤖 2 Subagents                      │
├─────────────────────────────────────┤
│ ▼ security-sentinel                 │
│   📖 Reading server.js              │
│   Tokens: 12.4k in / 2.1k out       │
├─────────────────────────────────────┤
│ ▼ performance-oracle                │
│   🔍 Grep: "polling"                │
│   Tokens: 8.2k in / 1.5k out        │
└─────────────────────────────────────┘
```

**Implementation:**
1. Parse subagent description from Task tool's `description` parameter
2. Track last tool call per subagent
3. Accumulate token usage from `usage` fields
4. Show expandable panel with details

- **Pros:** Full visibility into subagent activity
- **Cons:** More complex UI, more parsing logic
- **Effort:** Medium
- **Risk:** Low

### Option B: Hover/tap for details
- Keep badge minimal
- Show tooltip/popover on interaction
- **Pros:** Cleaner default UI
- **Cons:** Requires interaction to see details
- **Effort:** Medium
- **Risk:** Low

## Technical Details

**Subagent log entry structure:**
```json
{
  "type": "assistant",
  "message": {
    "content": [...],
    "usage": {
      "input_tokens": 12400,
      "output_tokens": 2100
    }
  }
}
```

**Task tool invocation (in parent session):**
```json
{
  "type": "tool_use",
  "name": "Task",
  "input": {
    "description": "security-sentinel",
    "prompt": "Review for security issues..."
  }
}
```

## Acceptance Criteria

- [ ] Subagent names/descriptions shown (not just hex IDs)
- [ ] Current tool being used visible for each subagent
- [ ] Token usage (input/output) tracked and displayed
- [ ] Panel expandable/collapsible for space efficiency
- [ ] Updates in real-time as subagents work

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-27 | Created | User feedback from code review session |
