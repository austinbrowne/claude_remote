---
title: "feat: Merge tool_use and tool_result into single chat cards"
type: feat
date: 2026-01-31
---

# Merge tool_use and tool_result into Single Chat Cards

## Problem

Every tool call produces **two separate message bubbles** in the iOS chat:
1. A `tool` card showing the tool name + input (e.g. "Bash: `git status`")
2. A `tool_result` card showing the output

This doubles the visual noise. A single collapsible card showing "Bash: `git status` → output" is more compact and easier to scan.

## Proposed Solution

Pass `block.id` from the server so tool_result messages can reference their parent tool_use. On the iOS side, when a `tool_result` arrives that matches a pending `tool` message, merge them into one message instead of appending a new one.

## Changes

### 1. server.js — Pass `toolUseId` on both messages

Currently `block.id` (the tool_use correlation ID) is available in `parseLogEntry` but never sent to the client.

**`server.js:parseLogEntry` — tool_use emission (permission_request, tool, etc.)**

Add `toolUseId: block.id` to every tool_use emission that currently lacks it:

```javascript
// Permission tools (line ~868)
results.push({
  type: 'permission_request',
  tool: ...,
  input: ...,
  toolUseId: block.id,   // ADD
  timestamp
});

// Generic tools (line ~924)
results.push({
  type: 'tool',
  tool: block.name || 'unknown',
  input: block.input || {},
  toolUseId: block.id,   // ADD
  timestamp
});
```

**`server.js:parseLogEntry` — tool_result emission (line ~964)**

The tool_result entry has `entry.message.content` which is an array containing `tool_result` blocks with `tool_use_id`. Extract and pass it:

```javascript
if (entry.toolUseResult) {
  // Extract tool_use_id from content blocks for correlation
  let toolUseId = null;
  if (Array.isArray(entry.message?.content)) {
    const resultBlock = entry.message.content.find(b => b.type === 'tool_result');
    toolUseId = resultBlock?.tool_use_id || null;
  }

  const result = entry.toolUseResult.stdout || entry.toolUseResult.stderr || '';
  results.push({
    type: 'tool_result',
    content: result.trim() || '(completed)',
    isError: !!entry.toolUseResult.stderr && !entry.toolUseResult.stdout,
    toolUseId,            // ADD — matches the tool_use block.id
    timestamp
  });
}
```

- [ ] Add `toolUseId: block.id` to `permission_request` emission
- [ ] Add `toolUseId: block.id` to generic `tool` emission
- [ ] Extract `tool_use_id` from `entry.message.content` and add to `tool_result` emission

### 2. WebSocketMessage.swift — Add `toolUseId` to ClaudeOutputData

```swift
// ClaudeOutputData
let toolUseId: String?    // ADD — correlation ID for tool_use ↔ tool_result
```

- [ ] Add `toolUseId` field to `ClaudeOutputData`

### 3. Message.swift — Add `toolUseId` and result fields

```swift
public struct Message: Identifiable, Sendable {
    // existing fields...
    let toolUseId: String?          // ADD — links tool call to result
    var resultContent: String?      // ADD — merged result text (mutable for merging)
    var resultIsError: Bool         // ADD — was the result an error?
}
```

- [ ] Add `toolUseId`, `resultContent`, `resultIsError` to Message
- [ ] Update `init` and all call sites

### 4. AppState.swift — Merge tool_result into existing tool message

Replace the simple `appendMessage` call for tool_results with a merge-or-append strategy:

```swift
/// Merge a tool_result into its matching tool message, or append standalone
public func mergeOrAppendToolResult(_ message: Message) {
    if let toolUseId = message.toolUseId,
       let index = messages.lastIndex(where: { $0.toolUseId == toolUseId && $0.type == .tool }) {
        messages[index].resultContent = message.content
        messages[index].resultIsError = message.resultIsError
    } else {
        appendMessage(message)
    }
}
```

- [ ] Add `mergeOrAppendToolResult` to AppState
- [ ] Make `resultContent` and `resultIsError` mutable (`var`) on Message

### 5. AppCoordinator.swift — Route tool_results through merge

In the claude_output handler, when the message type is `tool_result`, call the merge function instead of `appendMessage`:

```swift
case .claudeOutput(_, let data):
    // ... existing status_update handling ...

    guard let msg = buildMessage(...) else { return }

    if msg.type == .toolResult {
        state.mergeOrAppendToolResult(msg)
    } else {
        state.appendMessage(msg)
    }
```

- [ ] Route `.toolResult` messages through `mergeOrAppendToolResult`
- [ ] Pass `toolUseId` through `buildMessage`

### 6. ToolCardView.swift — Render merged card

Update ToolCardView to show both input and result when `resultContent` is present:

```swift
struct ToolCardView: View {
    let message: Message
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header: tool name + chevron
            headerRow

            if isExpanded {
                Divider()
                // Tool input (existing)
                if let input = message.toolInput { ... }
                // Tool result (merged)
                if let result = message.resultContent {
                    Divider()
                    resultSection(result, isError: message.resultIsError)
                }
            }
        }
        .background(...)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
```

The card header shows `tool name` (e.g. "Bash"). Tapping expands to show input + output stacked vertically inside one card. A `.toolResult` message that failed to merge (standalone) still renders normally.

- [ ] Update ToolCardView to render `resultContent` inside the same card
- [ ] Show result below input with a divider when expanded
- [ ] Handle standalone `tool_result` messages (no merge match) gracefully
- [ ] Color the result border red if `resultIsError`

### 7. PromptService — No changes needed

`PromptService.handleClaudeOutput` already handles `tool_result` for dismissing permission prompts. The merge happens at the `AppState` level before prompt handling, so the prompt flow is unaffected. The `tool_result` type still triggers `dismissPrompt()`.

### 8. History — Merge during history loading

In `AppCoordinator`'s history handler, apply the same merge logic when converting `HistoryEntry` items:

```swift
case .history(_, let data):
    state.clearMessages()
    for entry in data {
        if entry.type == "status_update" { continue }
        guard let msg = messageFromHistoryEntry(entry) else { continue }
        if msg.type == .toolResult {
            state.mergeOrAppendToolResult(msg)
        } else {
            state.appendMessage(msg)
        }
    }
```

And in the history data from the server, include `toolUseId` on history entries that have it.

- [ ] Pass `toolUseId` through history entries in server.js `buildHistoryResults`
- [ ] Use `mergeOrAppendToolResult` during history loading
- [ ] Add `toolUseId` to HistoryEntry model

## Acceptance Criteria

- [ ] Tool call + result renders as one card (not two separate bubbles)
- [ ] Card is collapsed by default, showing just the tool name
- [ ] Expanding shows input and result stacked vertically
- [ ] Error results show red styling
- [ ] History loads with merged cards
- [ ] Permission request flow still works (prompt dismiss on result)
- [ ] Standalone tool_results (no matching tool) still render normally
- [ ] `swift build` passes
- [ ] Tests pass

## References

- `server.js:parseLogEntry` — tool_use at line ~847, tool_result at line ~964
- `WebSocketMessage.swift:ClaudeOutputData` — message model
- `Message.swift` — Message struct
- `AppState.swift:appendMessage` — message storage
- `AppCoordinator.swift:handleClaudeOutput` — message routing
- `ToolCardView.swift` — current rendering
- `PromptService.swift:handleClaudeOutput` — permission dismiss logic
