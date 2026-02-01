---
title: "fix: Sync session mode from terminal state instead of blind cycling"
type: fix
date: 2026-01-31
---

# fix: Sync session mode from terminal state instead of blind cycling

## Problem

The iOS app's mode button (plan/act/default) is broken in three ways:

1. **Wrong modes**: The app has `plan`, `act`, `defaultMode` — but Claude Code's actual modes are `default`, `acceptEdits`, `plan`. There is no "Act" mode; it's "Accept Edits."

2. **Blind cycling**: When the user taps the mode button, the app optimistically advances to `.next` in a hardcoded cycle. The real Shift+Tab cycle is `Default → Accept Edits → Plan → Default`, and the app gets this wrong.

3. **No external sync**: If Claude changes modes (via Shift+Tab in terminal, `EnterPlanMode` tool, or `/plan` command), the iOS app has no idea. The mode indicator shows stale/wrong state indefinitely.

**Root cause**: The server has zero awareness of session mode. The iOS app tracks mode purely client-side with an optimistic state machine that doesn't match reality.

## Research Findings

### Signal 1: `permissionMode` field on JSONL user entries (BEST)

Every human-typed `type: "user"` entry in the JSONL log has a **top-level `permissionMode` field** with one of three values:

| `permissionMode` | UI Name | Description |
|---|---|---|
| `"default"` | Default | Standard — asks permission for each tool |
| `"acceptEdits"` | Accept Edits | Auto-approves file edits, prompts for Bash |
| `"plan"` | Plan | Read-only planning, no tool execution |

This field is present on user entries that have `thinkingMetadata` (i.e., human-typed messages, NOT tool results). The server already reads these entries — it just ignores this field.

**Limitation**: Only updates when the user sends a message. If the user presses Shift+Tab but doesn't type anything, no JSONL entry is written.

### Signal 2: Hooks receive `permission_mode` on every tool event

Every Claude Code hook (`PreToolUse`, `PostToolUse`, `SessionStart`, etc.) receives a `permission_mode` field in its JSON input. A hook script could write this to a file or notify the server, giving real-time updates even for Shift+Tab changes.

**This is the most reliable real-time signal** — it fires on every tool call, so the mode is always fresh during active processing.

### Signal 3: `EnterPlanMode` / `ExitPlanMode` tool_use blocks

These appear as `tool_use` blocks in assistant messages. The server's `parseLogEntry` already processes tool_use blocks — it can detect these.

### Signal 4: Statusline JSON (recently added)

GitHub Issue #21516 ("Expose Plan/Edit Mode in Statusline JSON") was marked **COMPLETED** on Jan 29, 2026. The `permission_mode` field may now be in the statusline JSON input, though docs haven't been updated yet.

## Approach: Two-Layer Detection

### Layer 1: JSONL `permissionMode` parsing (passive, no extra config)

The server already reads every JSONL entry. In `parseLogEntry`, extract `permissionMode` from user entries and emit a `mode_change` message. This requires zero user setup.

In `parseLogEntry`, for `type: "user"` entries:
```javascript
// Before returning results, check for mode changes
if (entry.permissionMode) {
  results.push({ type: 'mode_change', mode: entry.permissionMode });
}
```

Also detect `EnterPlanMode`/`ExitPlanMode` in tool_use blocks:
```javascript
if (block.name === 'EnterPlanMode') {
  results.push({ type: 'mode_change', mode: 'plan' });
}
if (block.name === 'ExitPlanMode') {
  results.push({ type: 'mode_change', mode: 'default' });
}
```

### Layer 2: Hook-based detection (real-time, optional setup)

For users who want instant mode sync (even between tool calls), provide a Claude Code hook that notifies the server:

```json
// ~/.claude/settings.json
{
  "hooks": {
    "PreToolUse": [{
      "type": "command",
      "command": "curl -s -X POST http://localhost:3456/api/mode -H 'Content-Type: application/json' -d \"{\\\"permission_mode\\\": \\\"$(cat | jq -r .permission_mode)\\\", \\\"session_id\\\": \\\"$(cat | jq -r .session_id)\\\"}\""
    }]
  }
}
```

This is a nice-to-have enhancement and can be a separate PR. The JSONL approach is sufficient for v1.

### Server: Track and broadcast mode

**Broadcast** `mode_change` as a top-level message (same pattern as `token_usage`):
```javascript
if (item.type === 'mode_change') {
  const sessionData = activeSessions.get(sessionId);
  if (sessionData && sessionData.mode !== item.mode) {
    sessionData.mode = item.mode;
    broadcastToClients({
      type: 'mode_change',
      sessionId: sessionId,
      mode: item.mode
    });
  }
}
```

**On watch**: Send current mode in the `watching` response so the iOS app gets the correct mode immediately when switching sessions.

**History**: Scan history for the last `permissionMode` to determine current mode when a client starts watching. Filter `mode_change` items from history broadcast (only latest matters).

### iOS: Server-driven mode display

**Fix `SessionMode` enum**:
```swift
public enum SessionMode: String, Sendable {
    case defaultMode = "default"
    case acceptEdits = "acceptEdits"
    case plan = "plan"

    public var label: String {
        switch self {
        case .defaultMode: "Default"
        case .acceptEdits: "Accept Edits"
        case .plan: "Plan"
        }
    }
}
```

**Remove optimistic cycling**: `modeToggleResult` should just show a toast ("Toggling mode..."), not advance state. The actual mode update comes from the server's `mode_change` broadcast.

**Handle `mode_change`**: New `ServerMessage` case that sets `state.sessionMode` from the server value.

**Handle `watching`**: Read initial mode from session data.

## Files to Modify

| File | Change |
|------|--------|
| `server.js` (parseLogEntry) | Extract `permissionMode` from user entries; detect `EnterPlanMode`/`ExitPlanMode` tool_use |
| `server.js` (watcher loop) | Broadcast `mode_change` as top-level message; store mode in `activeSessions` |
| `server.js` (sendRecentHistory) | Scan history for last `permissionMode`; filter `mode_change` from broadcast |
| `server.js` (watching response) | Include current `mode` in session data |
| `WebSocketMessage.swift` | Add `modeChange(sessionId: String?, mode: String)` case |
| `AppState.swift` | Fix `SessionMode` enum: `defaultMode`/`acceptEdits`/`plan` with correct labels |
| `AppCoordinator.swift` | Handle `modeChange`; remove optimistic toggle; read mode on watch |
| `InputBarView.swift` | Update mode button icons/colors for 3 correct modes |
| `WebSocketMessageTests.swift` | Add decode test for `mode_change` |
| `AppCoordinatorTests.swift` | Update mode toggle tests |

## Acceptance Criteria

- [ ] `SessionMode` enum has correct values: `default`, `acceptEdits`, `plan`
- [ ] Mode display shows correct labels: "Default", "Accept Edits", "Plan"
- [ ] When Claude enters plan mode (via `EnterPlanMode` tool), iOS shows "Plan" within ~1s
- [ ] When `permissionMode` changes on a user entry, iOS reflects the new mode
- [ ] When switching to a session, iOS shows the correct current mode immediately
- [ ] Mode button still sends Shift+Tab, but UI updates from server (not optimistic)
- [ ] Session switch resets mode to default
- [ ] `mode_change` messages don't pollute the chat history
- [ ] `swift build` and `swift test` pass

## Not in Scope

- Hook-based real-time mode detection (Layer 2) — separate PR
- Statusline JSON integration — needs docs update verification first
- Changing the mode toggle to a picker — separate UX decision

## References

- `server.js:817-1020` — `parseLogEntry` function
- `server.js:413-420` — watcher broadcast loop (pattern for top-level messages)
- `AppCoordinator.swift:304-308` — current optimistic mode toggle handler
- `AppState.swift:11-33` — `SessionMode` enum
- `InputBarView.swift:57-61, 181-229` — mode button UI
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) — `permission_mode` in hook inputs
- [GitHub #21516](https://github.com/anthropics/claude-code/issues/21516) — Statusline JSON mode exposure (completed Jan 29, 2026)
- [GitHub #6227](https://github.com/anthropics/claude-code/issues/6227) — Expose permission mode to hooks/statusline
