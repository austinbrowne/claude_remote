---
title: "Hybrid macOS Adapter for Multi-Source Session Discovery"
date: 2026-03-20
status: approved
type: standard
tags: [platform-adapter, macos, tmux, iterm, session-discovery]
---

# Hybrid macOS Adapter — Standard Plan

## Problem

On macOS with iTerm tmux integration (`tmux -CC`), Claude sessions can exist in both tmux panes and regular iTerm tabs. The current single-adapter architecture forces a choice: tmux adapter (misses iTerm tabs) or iTerm adapter (loses tmux management). This caused a real incident where a session in a regular iTerm tab was invisible to the server.

## Goals

1. Discover ALL Claude sessions on macOS regardless of where they're running
2. Route injection to the correct mechanism based on session type
3. Preserve tmux session management features (new terminal, kill pane)
4. Zero changes to clients (web + iOS), session-discovery.js, or command-injection.js
5. Minimal, backward-compatible changes to server.js and linux-tmux.js

## Solution

Create `lib/platform/macos-hybrid.js` — a thin routing adapter that delegates to the existing tmux and iTerm adapters. Discovery merges both sources with dedup. Injection dispatches by target format (`%N` → tmux, `ttysN` → AppleScript).

## Technical Approach

**Delegation, not duplication.** The hybrid adapter imports functions from both `linux-tmux.js` and `macos-iterm.js`. No code is copied. A `isTmuxTarget(target)` helper routes each call.

**Dedup strategy:**
1. Run both adapters' `getActiveProcesses()` in parallel
2. Build a TTY Set from tmux results using the new `deviceTty` field (e.g., `/dev/ttys010` → `ttys010`)
3. Filter iTerm results: exclude any process whose TTY is in the tmux pane TTY Set
4. Normalize iTerm results: add `isClaude: true` (iTerm ps scan already filters for claude processes)
5. Merge both lists

**Target format as dispatch key:**
- `%\d+` → tmux pane ID → `tmux send-keys`
- `ttys\d+` → macOS TTY device → AppleScript via osascript
- No new session fields or adapter tags needed in session-discovery.js or clients

**detect.js selection logic:**
- `CLAUDE_REMOTE_ADAPTER=tmux` on darwin → hybrid adapter (log: `[Platform] Using hybrid adapter (macOS + tmux)`)
- `CLAUDE_REMOTE_ADAPTER=tmux` on linux → pure tmux adapter (unchanged)
- darwin auto-detect with tmux available → hybrid adapter
- darwin auto-detect without tmux → pure iTerm adapter (unchanged)
- `CLAUDE_REMOTE_ADAPTER=iterm` on darwin → pure iTerm adapter (explicit opt-out from hybrid)

**sendModeToggle fix:**
- server.js `mode_toggle` case (line 1212) currently calls `sendModeToggle()` with no arguments
- Fix: extract TTY from `activeSessions.get(msg.sessionId)` (same pattern as `escape` case at line 977)
- Pass TTY to `sendModeToggle(tty)` so the hybrid adapter can route correctly

**Legacy inject handling:**
- Legacy functions (`injectCommandLegacy`, `sendEscapeKeyLegacy`) delegate to iTerm adapter
- These use clipboard + paste to frontmost iTerm window — not TTY-targeted
- For tmux sessions where primary injection fails, the legacy fallback pastes to the wrong window. This is the same behavior as before (tmux adapter throws on legacy). In practice, tmux `send-keys` is reliable and the fallback rarely triggers.

## Implementation Steps

### Step 1: Add `deviceTty` field to tmux adapter

Small, backward-compatible change to `lib/platform/linux-tmux.js`:
- Add `#{pane_tty}` to the `list-panes` format string (line 125)
- Include `deviceTty` in returned objects (e.g., `/dev/ttys010`)
- Existing tests only check presence of `pid`, `tty`, `cwd` — adding a field is non-breaking
- This eliminates the need for a separate `tmux list-panes` call in the hybrid adapter

### Step 2: Create `lib/platform/macos-hybrid.js`

- Import and delegate to `linux-tmux.js` and `macos-iterm.js`
- `isTmuxTarget(target)`: `/^%\d+$/.test(target)` — routes by target format
- `validateTarget(target)`: call both adapters' validators via OR — accept if either returns null, reject if both return errors
- `getActiveProcesses()`:
  1. Run both adapters in parallel
  2. Build TTY Set from tmux results' `deviceTty` field (strip `/dev/` prefix)
  3. Filter iTerm results against TTY Set
  4. Normalize iTerm results: add `isClaude: true`
  5. If tmux discovery fails, skip iTerm scan entirely (return empty to avoid duplicates)
  6. Merge and return
- All injection functions: route by `isTmuxTarget(target)`, delegate to appropriate adapter
- `sendModeToggle(target)`: route by target format. If target is undefined (shouldn't happen after server.js fix), default to iTerm
- Legacy functions: delegate to iTerm adapter (clipboard + paste to frontmost window)
- `healthCheck()`: run both, return structured result `{ ok, tmux: {...}, iterm: {...} }` — ok requires at least one adapter healthy. Log warning if one is degraded.
- TTY Set must be function-scoped (local to each `getActiveProcesses()` call), not module-scoped

### Step 3: Modify `lib/platform/detect.js`

- When `CLAUDE_REMOTE_ADAPTER=tmux` on darwin → require `./macos-hybrid`, log `[Platform] Using hybrid adapter (macOS + tmux)`
- When `CLAUDE_REMOTE_ADAPTER=iterm` on darwin → require `./macos-iterm` (explicit pure-iTerm opt-out)
- Auto-detect on darwin: check for tmux → hybrid if available, iTerm-only otherwise
- All other cases unchanged

### Step 4: Fix `sendModeToggle` in server.js

- In the `mode_toggle` case (line 1212), extract TTY from session:
  ```javascript
  let toggleTty = activeSessions.get(msg.sessionId)?.session?.tty;
  if (!toggleTty && msg.sessionId) {
    const sessions = await discoverSessions();
    const found = sessions.find(s => s.id === msg.sessionId);
    toggleTty = found?.tty;
  }
  await sendModeToggle(toggleTty);
  ```
- This mirrors the existing `escape` case pattern (line 977-1007)

### Step 5: Add tests

Test file: `test/macos-hybrid.test.js`
- `validateTarget()`: accepts `%0`, `%15`, `ttys001`, `ttys999`; rejects `null`, `%abc`, `ttysXYZ`, `%0;id`, injection attempts
- `isTmuxTarget()`: `%0` → true, `ttys001` → false, `undefined` → false
- `getActiveProcesses()` dedup: mock both adapters with overlapping sessions, verify no duplicates
- `getActiveProcesses()` tmux failure: verify returns empty (not duplicated iTerm results)
- `getActiveProcesses()` shape normalization: verify iTerm results include `isClaude: true`
- Injection routing: tmux target → tmux adapter called; iTerm target → iTerm adapter called
- `healthCheck()`: returns structured sub-adapter status
- Legacy functions: delegate to iTerm adapter

## Affected Files

| File | Action | Changes |
|------|--------|---------|
| `lib/platform/macos-hybrid.js` | **NEW** | Hybrid adapter (~150 lines) |
| `lib/platform/detect.js` | **MODIFY** | Add hybrid selection for darwin+tmux, `iterm` opt-out |
| `lib/platform/linux-tmux.js` | **MODIFY** | Add `#{pane_tty}` to format string, return `deviceTty` field (~3 lines) |
| `server.js` | **MODIFY** | Fix `mode_toggle` case to pass TTY target (~8 lines, mirrors `escape` pattern) |
| `test/macos-hybrid.test.js` | **NEW** | Tests for hybrid adapter |

**Unchanged:** `session-discovery.js`, `command-injection.js`, `macos-iterm.js`, `terminal-manager.js`, all client code (web + iOS)

## Acceptance Criteria

1. On macOS with tmux: server discovers Claude sessions in both tmux panes AND regular iTerm tabs
2. Commands injected into tmux sessions use `tmux send-keys`
3. Commands injected into iTerm-only sessions use AppleScript
4. No duplicate sessions when a Claude process runs inside a tmux pane (best-effort during rapid pane creation — race window is sub-second)
5. Existing `CLAUDE_REMOTE_ADAPTER=tmux` in `.env` gets hybrid behavior on macOS with a logged message
6. `CLAUDE_REMOTE_ADAPTER=iterm` provides explicit opt-out to pure iTerm behavior
7. Session management buttons (new terminal, kill pane) continue to work via tmux
8. Mode toggle works correctly for both tmux and iTerm sessions
9. All existing tests pass unchanged
10. Linux behavior completely unchanged

## Test Strategy

- Unit tests for `validateTarget()`, `isTmuxTarget()`, dedup logic, shape normalization
- Unit tests for injection routing (mock both adapters, verify correct delegation)
- Unit tests for tmux failure fallback (tmux returns error → empty result, no duplicates)
- Unit test for `healthCheck()` structured response
- Manual test: start Claude in regular iTerm tab + tmux pane, verify both appear in Claude Remote
- Manual test: inject commands into both session types, verify correct routing
- Manual test: mode toggle from both session types

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| tmux discovery fails | Low | Medium | Skip iTerm scan entirely, return empty — prevents duplicates |
| iTerm ps scan returns stale processes | Low | Low | Existing `fsp.access()` checks in session-discovery.js filter dead sessions |
| Legacy inject sends to wrong window for tmux sessions | Low | Low | tmux send-keys is reliable; fallback rarely triggers. Same behavior as before. |
| Dedup race during rapid pane creation | Very Low | Low | Sub-second window. Resolves on next discovery cycle (typically 5s). |
| macOS Accessibility permission not granted | Low | Medium | osascript fails for iTerm sessions only; tmux sessions unaffected. Existing behavior. |
