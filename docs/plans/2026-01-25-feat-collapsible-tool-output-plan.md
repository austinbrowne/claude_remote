---
title: Collapsible Tool Output
type: feat
date: 2026-01-25
---

# Collapsible Tool Output

## Overview

Make tool calls and their output collapsible in the mobile UI - collapsed by default with a summary, expandable on tap to see full content.

## Problem Statement

Currently, tool output (bash commands, file edits, read results) clutters the mobile view with truncated but still verbose output. Users primarily care about Claude's responses, not the intermediate tool calls.

## Proposed Solution

Show tool messages as single-line summaries that expand on tap:

**Collapsed (default):**
```
▶ Bash: git status...
▶ Read: server.js (796 lines)
▶ Edit: public/index.html
```

**Expanded (on tap):**
```
▼ Bash: git status
  ┌────────────────────────────
  │ On branch main
  │ Changes not staged for commit:
  │   modified: server.js
  │   modified: public/index.html
  └────────────────────────────
```

## Implementation

### 1. CSS Changes

```css
/* Collapsible tool messages */
.message.tool, .message.tool_result {
  cursor: pointer;
}

/* Override existing tool_result constraints - now handled by .tool-details */
.message.tool_result {
  max-height: none;
  overflow-y: visible;
  padding-left: 0;
  border-left: none;
  margin-left: 0;
}

.message.tool .tool-details,
.message.tool_result .tool-details {
  display: none;
  margin-top: 8px;
  padding: 8px;
  background: var(--bg-primary);
  border-left: 2px solid var(--tool-msg);
  font-size: 11px;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
}

.message.tool.expanded .tool-details,
.message.tool_result.expanded .tool-details {
  display: block;
}

.tool-summary {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tool-chevron {
  transition: transform 0.2s;
}

.expanded .tool-chevron {
  transform: rotate(90deg);
}
```

### 2. JavaScript Changes

**Modify `appendMessage()` for tool types (replaces existing lines 1274-1282):**

```javascript
if (data.type === 'tool') {
  const toolInput = formatToolInput(data.input);
  // Guard against null/undefined input
  const fullInput = data.input == null
    ? ''
    : typeof data.input === 'string'
      ? data.input
      : JSON.stringify(data.input, null, 2);
  msg.innerHTML = `
    <div class="tool-summary" onclick="this.parentElement.classList.toggle('expanded')">
      <span class="tool-chevron">▶</span>
      <span class="tool-name">${escapeHtml(data.tool)}</span>
      <span style="color: var(--text-muted)">${escapeHtml(toolInput.substring(0, 50))}${toolInput.length > 50 ? '...' : ''}</span>
    </div>
    <div class="tool-details"><pre>${escapeHtml(fullInput)}</pre></div>
  `;
} else if (data.type === 'tool_result') {
  const result = typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2);
  // Split once, reuse for preview and line count
  const lines = result.split('\n');
  const preview = lines[0].substring(0, 50);
  const lineCount = lines.length;
  // Show ellipsis if first line truncated OR multiple lines exist
  const needsEllipsis = lines[0].length > 50 || lineCount > 1;
  msg.innerHTML = `
    <div class="tool-summary" onclick="this.parentElement.classList.toggle('expanded')">
      <span class="tool-chevron">▶</span>
      <span style="color: var(--text-muted)">Result: ${escapeHtml(preview)}${needsEllipsis ? '...' : ''} (${lineCount} lines)</span>
    </div>
    <div class="tool-details"><pre>${escapeHtml(result)}</pre></div>
  `;
}
```

## Acceptance Criteria

- [x] Tool calls show collapsed with chevron + tool name + truncated input (50 chars)
- [x] Tool results show collapsed with "Result:" + first line preview + line count
- [x] Ellipsis shown when content is truncated OR has multiple lines
- [x] Tapping expands to show full content
- [x] Tapping again collapses
- [x] Expanded content scrollable if > 200px, with pre-wrap for long lines
- [x] Chevron rotates on expand/collapse
- [x] Null/undefined inputs handled gracefully

## Files to Modify

| File | Changes |
|------|---------|
| `public/index.html:187-212` | Add CSS for collapsible states, override existing tool_result constraints |
| `public/index.html:1274-1282` | Replace existing truncation with collapsible rendering in `appendMessage()` |
