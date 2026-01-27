---
status: pending
priority: p3
issue_id: "046"
tags:
  - feature
  - permissions
  - mcp
dependencies: []
---

# MCP/Plugin Tool Usage Not Prompting for Approval

## Problem Statement

When Claude Code uses MCP (Model Context Protocol) plugin tools, mobile app doesn't show permission prompts. Plugin tools may have side effects but bypass user approval.

**Why it matters**: Third-party tools executing without user awareness.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js` - `parseLogEntry()`

**MCP tool naming pattern:**
- `mcp__servername__toolname` (e.g., `mcp__github__create_issue`)

**Current permission detection:**
- Only checks for `Bash`, `Edit`, `Write`
- MCP tools not recognized

## Proposed Solution

Add MCP tool detection:

```javascript
const isMcpTool = toolName.startsWith('mcp__');
if (toolName === 'Bash' || toolName === 'Edit' || toolName === 'Write' || toolName === 'WebFetch' || isMcpTool) {
  parsed.push({
    type: 'permission_request',
    tool: isMcpTool ? formatMcpToolName(toolName) : toolName,
    input: toolInput
  });
}

function formatMcpToolName(name) {
  // mcp__github__create_issue -> GitHub: create_issue
  const parts = name.split('__');
  return `${parts[1]}: ${parts[2]}`;
}
```

**Display format:**
```
┌─────────────────────────────────────┐
│ 🔐 Permission Request               │
│                                     │
│ Allow GitHub: create_issue?         │
│ { title: "Fix bug", body: "..." }   │
│                                     │
│     [Yes]        [No]               │
└─────────────────────────────────────┘
```

## Acceptance Criteria

- [ ] MCP tool calls show permission prompt
- [ ] Tool name formatted readably (not raw mcp__ format)
- [ ] Tool input shown in prompt
- [ ] Can approve/deny from mobile

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-27 | Created | User feedback - lower priority |
