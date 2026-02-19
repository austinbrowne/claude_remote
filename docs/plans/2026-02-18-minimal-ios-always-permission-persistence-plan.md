---
title: "Fix iOS Always Permission Not Persisting"
tier: minimal
status: approved
date: 2026-02-18
tags: [ios, permissions, always-allow, promptservice, bug-fix]
security_sensitive: false
---

# Fix iOS "Always" Permission Not Persisting

## Problem

When a user taps "Always" on an iOS permission prompt, the grant works momentarily but is wiped within 30 seconds. The root cause is in `PromptService.updateAllowedTools()` which **replaces** the entire `allowedTools` set from every `claudeState` message (sent every 30s and on status changes).

The web client doesn't have this bug because its `alwaysAllowedTools` is a separate local `Set` that `claudeState` never touches.

**Trace:**
1. User taps "Always" -> `cascadeAlwaysAllow("Bash")` -> `allowedTools.insert("Bash")`
2. Server records grant in `sessionGranted` (if `permissionToolMap` lookup succeeds) -> broadcasts `claudeState`
3. iOS receives `claudeState` -> `updateAllowedTools()` -> `allowedTools = Set(server.allowedTools) U Set(server.sessionGranted)` -- entirely replaces the set
4. If server grant succeeded: tool in `sessionGranted` -> preserved
5. If server grant failed (permissionToolMap miss, TTL expiry, race): tool NOT in `sessionGranted` -> **local grant wiped**

Even when the server grant succeeds, a stale `claudeState` from the 30s periodic sync can briefly wipe the grant before the updated `claudeState` arrives.

**Secondary issue:** MCP tool name mismatch. Server stores raw names (`mcp__server__tool`) in `sessionGranted` but sends formatted names (`Server: tool`) in `permission_request.tool`. iOS `cascadeAlwaysAllow` stores formatted name, but `updateAllowedTools` replaces with raw names from server. For MCP tools, the grant is **always** lost on `claudeState`.

## Solution

Add an `alwaysAllowedTools: Set<String>` to `PromptService` that survives `claudeState` updates. This mirrors the web client's `alwaysAllowedTools` pattern. The local set is an **optimistic grant** -- populated unconditionally when the user taps "Always", independent of server-side outcome.

## Design Decisions

1. **Optimistic local grant:** `alwaysAllowedTools` is populated immediately on user tap, before server acknowledgment. This is intentional -- the user explicitly chose "Always" and the local set ensures that intent is honored even if the server-side `permissionToolMap` lookup fails.

2. **Defensive revocation detection:** Although this codebase has no tool revocation mechanism today (`allowedTools` is loaded once at session start, `sessionGranted` is monotonically additive), `updateAllowedTools()` defensively removes tools from `alwaysAllowedTools` if they were previously in the server's allowed set but are now absent. This prevents the local set from overriding a future server-side revocation.

3. **Clear at session-start:** `alwaysAllowedTools` is cleared both on session disconnect (via `clearQueue`) AND at the start of a new session connection, preventing cross-session leakage.

4. **In-memory only:** Grants do not persist across app restarts. This is intentional and acceptable for a session-scoped feature.

## Affected Files

| File | Change |
|------|--------|
| `ClaudeRemote/Sources/ClaudeRemote/Services/PromptService.swift` | Add `alwaysAllowedTools`, update `isToolAllowed`, update `cascadeAlwaysAllow`, update `clearQueue`, update `updateAllowedTools` |
| `ClaudeRemote/Tests/ClaudeRemoteTests/Services/PromptServiceTests.swift` | Add tests for grant persistence across `updateAllowedTools` calls |

## Technical Approach

**`PromptService.swift`:**

1. Add `private var alwaysAllowedTools: Set<String> = []`
   - `// SECURITY: Do not persist this set across app launches. Grants are session-scoped only.`

2. In `cascadeAlwaysAllow(tool:)`: add to `alwaysAllowedTools` (in addition to existing `allowedTools.insert`)

3. In `isToolAllowed(_:)`: check `allowedTools.contains(tool) || alwaysAllowedTools.contains(tool)`
   - Add debug log when auto-approving via `alwaysAllowedTools` to distinguish from server-granted approvals

4. In `updateAllowedTools(_:)`: defensive revocation detection
   - Before replacing `allowedTools`, compute `revoked = previousAllowedTools.subtracting(newAllowedTools)`
   - Remove revoked tools from `alwaysAllowedTools`: `alwaysAllowedTools.subtract(revoked)`
   - Then replace `allowedTools` as before

5. In `clearQueue()`: also clear `alwaysAllowedTools` (session disconnect/switch)

6. Add `clearLocalGrants()` method called at session-start (before any permission processing for the new session)

No server changes needed. The server-side `sessionGranted` tracking works correctly for non-MCP tools. The MCP name mismatch is a separate optimization -- the client-side `alwaysAllowedTools` handles it correctly since it stores the formatted name (matching incoming `data.tool`).

## Acceptance Criteria

- [ ] Tapping "Always" for Bash persists across `claudeState` updates -- future Bash permissions are auto-approved
- [ ] `alwaysAllowedTools` is cleared on session disconnect/switch (no cross-session leakage)
- [ ] `alwaysAllowedTools` is cleared at session-start before processing new session's permissions
- [ ] If server removes a tool from allowedTools, it is also removed from `alwaysAllowedTools` (revocation detection)
- [ ] MCP tool "Always" grants persist (formatted name in local set matches incoming `data.tool`)
- [ ] Existing behavior preserved: `updateAllowedTools` still syncs server-side allowedTools and sessionGranted
- [ ] Auto-approvals from `alwaysAllowedTools` are logged for debugging
- [ ] All existing tests pass

## Test Strategy

- Test `isToolAllowed` returns true for locally-granted tool
- Test `updateAllowedTools` does NOT wipe `alwaysAllowedTools` (normal case)
- Test `updateAllowedTools` DOES remove from `alwaysAllowedTools` when tool is revoked (revocation detection)
- Test `clearQueue` clears `alwaysAllowedTools`
- Test `cascadeAlwaysAllow` adds to `alwaysAllowedTools`
- Test locally-granted MCP tool survives `updateAllowedTools` with raw names
- Test session switch clears `alwaysAllowedTools` (connect to session A, grant tool, switch to session B, verify set is empty)

## Risks

- **MEDIUM:** `alwaysAllowedTools` is an optimistic client-side grant. If the server independently validates injected approvals (it does -- `injectCommandToTty` sends the literal "always" string to Claude Code, which decides whether to honor it), the local set cannot bypass server-side policy. The revocation detection in `updateAllowedTools` provides additional defense.

## Past Learnings Applied

- From `permission-queue-concurrent-subagents.md`: Permission handling involves `cascadeAlwaysAllow`, pending permissions dict, and prompt queue -- all three must be considered when modifying grant behavior.
- From `parallel-agent-permission-queue-nuked-on-processing.md`: Don't clear permission state on status changes -- only on explicit session disconnect.
