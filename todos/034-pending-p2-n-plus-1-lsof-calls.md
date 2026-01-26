---
status: pending
priority: p2
issue_id: "034"
tags:
  - performance
  - code-review
dependencies: []
---

# N+1 Process Execution Pattern in getActiveClaude

## Problem Statement

The `getActiveClaude()` function spawns one `lsof` process per Claude process found, creating an N+1 pattern. Each `exec()` has ~50ms overhead.

**Why it matters**: With 10 Claude sessions, this adds 500ms+ latency to session discovery. This happens on every refresh.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/server.js` lines 50-70

```javascript
processes.forEach(proc => {
  exec(`lsof -a -p ${proc.pid} -d cwd 2>/dev/null | tail -1 | awk '{print $NF}'`, (err2, cwd) => {
```

For each Claude process found, spawns a separate `lsof` process.

## Proposed Solutions

### Option A: Batch PIDs in single lsof call (Recommended)
```javascript
const pids = processes.map(p => p.pid).join(',');
exec(`lsof -a -p ${pids} -d cwd 2>/dev/null`, (err, stdout) => {
  // Parse output once for all processes
  const lines = stdout.split('\n');
  // Match PID to cwd from combined output
});
```
- **Pros**: Single process spawn, much faster
- **Cons**: More complex output parsing
- **Effort**: Low
- **Risk**: Low

### Option B: Use /proc filesystem (Linux) or alternative
- Read from /proc/[pid]/cwd directly
- **Pros**: No exec overhead
- **Cons**: Not portable (macOS uses different approach)
- **Effort**: Medium
- **Risk**: Medium

## Recommended Action

Option A - Batch all PIDs in single lsof call.

## Technical Details

**Affected files:**
- `server.js:50-70` - getActiveClaude()

**Current latency:** ~50ms × N processes
**Expected improvement:** ~50ms total (fixed)

## Acceptance Criteria

- [ ] Single lsof call for all processes
- [ ] Session discovery time is O(1) not O(N)
- [ ] All processes still detected correctly
- [ ] Tested with 5+ concurrent Claude sessions

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-26 | Created | Identified during performance review |

## Resources

- Performance oracle agent finding
