# Terminal Parity Improvements Brainstorm

**Date:** 2026-01-28
**Status:** Ready for planning

## What We're Building

Four features to bring Claude Remote mobile closer to feature parity with Claude Code terminal:

### 1. Inline Task Progress List
Show live task checkboxes below the status bar, always visible when tasks exist.

- Display: checkbox + subject for each task
- States: pending (empty), in_progress (spinner), completed (checkmark)
- Compact single-line per task
- Auto-hide when no tasks

### 2. Expanded Subagent Dropdown
Enhance the existing badge dropdown to show richer per-agent details.

- Agent description/name
- Current tool being used (or "idle")
- Token usage (input/output)
- Status indicator (running/waiting/complete)
- Clickable to filter output to that agent (stretch goal)

### 3. Inline File Diff Preview
Show compact diffs within Edit/Write tool messages.

- Collapsible like current tool details
- Green/red syntax highlighting for +/- lines
- Limited context (3 lines before/after)
- Full diff on expand

### 4. Checkpoint View + Revert
Display checkpoint history and allow reverting from mobile.

- List of checkpoints with timestamps
- Description of what changed
- "Revert to this point" button
- Confirmation before revert (destructive action)

## Why These Approaches

**Inline over modals:** Mobile users want glanceable info without extra taps. Inline lists and expanded dropdowns provide information density without context switching.

**View + revert (not full control):** Creating checkpoints is a deliberate terminal action. But reverting is useful when monitoring remotely - "that went wrong, roll it back."

**Compact diffs:** Full diffs are hard to read on mobile. Showing key changes inline with expand option balances visibility and usability.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Task display | Inline list below status bar | Always visible, no extra tap |
| Subagent display | Enhanced dropdown | Builds on existing UI pattern |
| Diff display | Inline collapsible | Consistent with tool message pattern |
| Checkpoint control | View + revert | Useful remote control, not over-engineered |

## Technical Considerations

### Data Sources
- **Tasks:** Already parsed from TaskCreate/TaskUpdate in logs
- **Subagents:** Already tracked in activeSubagents map
- **Diffs:** Need to extract from Edit tool input (old_string/new_string)
- **Checkpoints:** Need new server endpoint or log parsing

### Server Changes Needed
- Checkpoint listing endpoint (or parse from Claude's checkpoint files)
- Checkpoint revert command injection

### Client Changes Needed
- Task list component (wire existing panel)
- Subagent dropdown enhancement
- Diff rendering component
- Checkpoint panel/modal

## Open Questions

1. **Checkpoint file location:** Where does Claude Code store checkpoints? Need to discover format.
2. **Revert mechanism:** Is there a `/revert` command or do we inject specific text?
3. **Task dependencies:** Show blocked-by relationships or keep simple?

## Out of Scope

- Creating checkpoints from mobile
- Full file browser
- Search/filter output (future improvement)
- Copy button on messages (future improvement)

## Next Steps

Run `/workflows:plan` to create implementation plan for these four features.
