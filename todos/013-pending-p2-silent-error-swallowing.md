---
status: pending
priority: p2
issue_id: "013"
tags: [code-review, quality, error-handling]
dependencies: []
---

# Silent Error Swallowing Makes Debugging Difficult

## Problem Statement

Multiple empty catch blocks silently ignore errors throughout the codebase. This makes debugging extremely difficult as legitimate errors are hidden and failures happen silently.

**Why it matters:** When something breaks, you have no idea why.

## Findings

**Locations:** `/Users/austin/Git_Repos/claude_remote/server.js`
- Lines 73-75: `discoverSessions()` - `} catch (e) { /* Skip invalid session files */ }`
- Lines 103-105: `watchSession()` - `} catch (e) { /* File might not exist yet */ }`
- Lines 138-140: watcher callback - `} catch (e) { /* Skip invalid JSON lines */ }`
- Line 422: `sendRecentHistory()` - `} catch (e) {}`

**Evidence:**
- 4+ empty catch blocks
- No logging of swallowed errors
- Comments don't explain what errors are expected

**Discovered by:** pattern-recognition-specialist agent

## Proposed Solutions

### Option A: Log Unexpected Errors (Recommended)
**Pros:** Maintains visibility, keeps intended behavior
**Cons:** More log output
**Effort:** Small
**Risk:** Low

```javascript
} catch (e) {
  // Expected: ENOENT for files that don't exist yet
  if (e.code !== 'ENOENT') {
    console.warn('Unexpected error in discoverSessions:', e.message);
  }
}
```

### Option B: Structured Error Categorization
**Pros:** Better debugging
**Cons:** More complex
**Effort:** Medium
**Risk:** Low

## Acceptance Criteria

- [ ] All catch blocks log unexpected errors
- [ ] Expected errors documented in comments
- [ ] No completely empty catch blocks

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | Never silently swallow errors |
