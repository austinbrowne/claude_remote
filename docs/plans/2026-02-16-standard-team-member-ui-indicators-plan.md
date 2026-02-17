---
type: standard
title: "Add UI indicators for active team members and team status"
date: 2026-02-16
status: ready_for_review
issue: 27
security_sensitive: false
tags: [ios, web, server, teams, ui]
---

# Plan: Add UI Indicators for Active Team Members and Team Status

## Problem
When Claude Code runs in Agent Teams mode, teammates appear as generic subagents with no team context. The user can't distinguish a team-coordinated swarm from independent subagents, can't see team member names/roles, and has no visibility into inter-teammate communication.

## Goals
1. Surface team existence and membership in mobile/web UI
2. Show teammate names, roles, and status (distinct from anonymous subagents)
3. Display which tasks each teammate owns
4. Track inter-teammate messages for visibility

## Solution Overview

**Key insight:** Agent Teams teammates are already spawned via the `Task` tool and write to the `subagents/` directory — the existing file watcher already picks them up. The gap is that team metadata (`team_name`, `name` from the Task tool input) is discarded during parsing. The fix extends the existing subagent pipeline rather than building a parallel one.

## Technical Approach

### Phase 1: Server-side team awareness (server.js)

1. **Extend `Task` tool parsing** (line ~1252): Extract `team_name` and `name` from `block.input` alongside existing `description` and `subagent_type`. Store in `pendingSubagentDescriptions` for correlation.

2. **Parse `TeamCreate`** (currently falls through at line 1270): Extract team name from `block.input.team_name`. Store active team in session data: `sessionData.activeTeam = { name, members: new Map(), createdAt }`.

3. **Parse `SendMessage`**: Extract `recipient`, `content`, `type` from `block.input`. When `type === 'message'` or `type === 'broadcast'`, emit a `team_message` event. Cap stored messages at 50 per session.

4. **Parse `TeamDelete`**: Clear `sessionData.activeTeam`.

5. **Extend `subagentData` in `watchSubagent()`** (line ~827): When correlating with `pendingSubagentDescriptions`, propagate `teamName` and `memberName` fields. A subagent with `teamName` set is a teammate.

6. **Extend `buildClaudeState()`** (line ~1610): Add `team` field alongside existing `subagents`:
   ```javascript
   team: sd.activeTeam ? {
     name: sd.activeTeam.name,
     members: Object.fromEntries(sd.activeTeam.members),
     recentMessages: sd.teamMessages?.slice(-10) || []
   } : null
   ```

7. **Extend `subagent_start` broadcast** (line ~837): Include `teamName` and `memberName` fields when present.

### Phase 2: iOS client (ClaudeRemote/)

8. **Extend `SubagentInfo`** (AppState.swift): Add optional `teamName: String?` and `memberName: String?` properties. No new model needed — teammates ARE subagents with team metadata.

9. **Extend `ServerMessage` decoding** (WebSocketMessage.swift): Parse `teamName` and `memberName` from `subagent_start`. Add `team_message` case.

10. **Extend `AppState`**: Add `activeTeamName: String?` and `teamMessages: [TeamMessage]` (simple struct: sender, recipient, content, timestamp). Cap at 50.

11. **AppCoordinator**: On `subagent_start` with `teamName`, set `state.activeTeamName`. On `claude_state` sync, populate team data. Clear on session switch.

12. **Extend `SubagentBadgeView`**: When `activeTeamName` is set, show team name in the badge header. Group teammates visually in the sheet — show member name instead of truncated agentId, show role/type, show which task they own (cross-reference `state.tasks` by owner name).

13. **Add teammate message timeline** to SubagentListSheet: Small section showing recent inter-teammate messages (similar to milestone timeline, but for team comms).

### Phase 3: Web client (public/js/)

14. **Extend `activeSubagents` Map entries** in connection.js: Store `teamName` and `memberName` when present in `subagent_start`.

15. **Extend `updateSubagentIndicator()`** in ui.js: When any subagent has `teamName`, show team badge variant with team name.

16. **Handle `team_message`** in connection.js: Store in a `teamMessages` array, update UI.

## Implementation Steps

| Step | Files | Description |
|------|-------|-------------|
| 1 | `server.js` | Extend Task tool parsing to capture team_name, name |
| 2 | `server.js` | Add TeamCreate/TeamDelete/SendMessage handlers in parseLogEntry |
| 3 | `server.js` | Add activeTeam + teamMessages to session data init |
| 4 | `server.js` | Extend buildClaudeState with team field |
| 5 | `server.js` | Extend subagent_start broadcast with team fields |
| 6 | `test/*.test.js` | Tests for team tool parsing and state |
| 7 | `AppState.swift` | Extend SubagentInfo, add activeTeamName, teamMessages |
| 8 | `WebSocketMessage.swift` | Parse teamName/memberName from subagent_start, add team_message |
| 9 | `AppCoordinator.swift` | Handle team fields in subagent_start, claude_state, team_message |
| 10 | `SubagentBadgeView.swift` | Show team name, group teammates, show member names + task ownership |
| 11 | `WebSocketMessageTests.swift` | Decode tests for team fields |
| 12 | `public/js/connection.js` | Handle team fields in subagent_start, team_message |
| 13 | `public/js/ui.js` | Team badge variant, teammate names in indicator |

## Affected Files

| File | Change Type |
|------|-------------|
| `server.js` | Modify (parseLogEntry, watchSubagent, buildClaudeState, session init) |
| `test/*.test.js` | Add (team parsing tests) |
| `AppState.swift` | Modify (extend SubagentInfo, add team state) |
| `WebSocketMessage.swift` | Modify (team fields in subagent_start, team_message case) |
| `AppCoordinator.swift` | Modify (handle team data) |
| `SubagentBadgeView.swift` | Modify (team grouping, member names) |
| `WebSocketMessageTests.swift` | Add (team decode tests) |
| `public/js/connection.js` | Modify (team fields, team_message handler) |
| `public/js/ui.js` | Modify (team badge variant) |

## Acceptance Criteria
- [ ] Teammates show with their assigned name (not truncated agentId)
- [ ] Team name visible in subagent badge when a team is active
- [ ] Task ownership shown next to teammate in list
- [ ] Team state clears on session switch and TeamDelete
- [ ] Regular (non-team) subagents still display normally
- [ ] buildClaudeState includes team data for new client connections
- [ ] Server tests cover TeamCreate/SendMessage/TeamDelete parsing
- [ ] iOS decode tests cover team fields

## Test Strategy
- **Server**: Test parseLogEntry for TeamCreate (extracts team name), Task with team_name (tags as teammate), SendMessage (captures message), TeamDelete (clears team). Test buildClaudeState includes team data.
- **iOS**: Decode tests for subagent_start with teamName/memberName fields. Test AppState team state lifecycle.
- **Manual**: Run `/fresh-eyes-review` or team swarm, verify mobile shows team indicator with member names and task assignments.

## Risks

| Risk | Mitigation |
|------|------------|
| Teammate JSONL logs may use different directory than `subagents/` | Investigation needed — if so, add parallel watcher. But Task-spawned teammates likely use the same directory. |
| `block.input` for TeamCreate may not contain member list upfront | Members are added incrementally via Task tool — track them as they appear via subagent_start with team_name |
| High-frequency SendMessage flooding | Throttle team_message broadcasts using existing `SUBAGENT_TOOL_THROTTLE_MS` pattern. Cap stored messages at 50. |

## Spec-Flow Analysis

### Primary flow: Team session
1. User triggers team operation (e.g. `/fresh-eyes-review`) → TeamCreate tool call → server detects team → broadcasts team state
2. Teammates spawned via Task tool with `team_name` → subagent files appear → server tags them as teammates → broadcasts `subagent_start` with team fields
3. Teammates work → existing subagent_tool/tokens flow continues → UI shows teammate names
4. Teammates send messages → SendMessage parsed → `team_message` broadcast → UI shows comms
5. Team completes → TeamDelete → team state cleared → UI returns to normal

### Edge cases
- Team created then immediately deleted (no members ever spawned) → clear state, no UI change
- Multiple sequential teams in one session → clear old team on TeamCreate
- Non-team subagents spawned during team session → show separately, no team badge on them
- Client connects mid-team → `buildClaudeState` sends team snapshot
