---
status: complete
priority: p3
issue_id: "038"
tags:
  - cleanup
  - code-review
  - maintainability
dependencies: []
---

# Dead Code Needing Removal

## Problem Statement

Several functions are no longer used after recent refactoring but remain in the codebase. Dead code adds maintenance burden and cognitive load.

**Why it matters**: ~88 lines of unused code to maintain.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html`

### Dead Functions

1. **`appendSubagentMessage()`** - Was used to show subagent output in main stream, now removed for cleaner UX
2. **`detectPromptType()`** - Permission detection moved to parseLogEntry, this function no longer called

**Discovered by:** code-simplicity-reviewer agent

## Proposed Solutions

### Option A: Remove dead functions (Recommended)
- Search for all usages
- Verify no calls exist
- Delete the functions
- **Pros:** Cleaner codebase
- **Cons:** None
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] All dead functions identified and removed
- [ ] No console errors after removal
- [ ] All existing functionality still works

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-27 | Created | Found during code review |
