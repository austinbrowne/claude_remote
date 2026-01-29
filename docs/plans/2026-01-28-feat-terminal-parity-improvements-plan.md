---
title: Terminal Parity Improvements
type: feat
date: 2026-01-28
---

# Terminal Parity Improvements

## Overview

Four features to bring Claude Remote mobile closer to feature parity with Claude Code terminal.

| Feature | Approach | Status |
|---------|----------|--------|
| Task Progress | Full inline rendering with new CSS/JS | Ready |
| Subagent Dropdown | Full enhanced dropdown with tool/token info | Ready |
| File Diffs | Proper LCS diff algorithm with line numbers | Ready |
| Checkpoints | Quick action button for `/rewind` | Ready |

## Review Feedback Applied

- **Feature 3 (Diffs):** Replaced naive before/after with proper LCS diff algorithm
- **Feature 4 (Checkpoints):** Simplified to `/rewind` button (we don't know checkpoint ID format)

---

## Feature 1: Inline Task Progress List

### Current State
- Server parses TaskCreate/TaskUpdate events (lines 813-830)
- Client stores in `tasks` Map and has `renderTasks()` function
- Existing collapsible panel (hidden by default)

### Implementation

**File: `public/index.html`**

1. **Replace collapsible panel with inline list** (~line 1336)

```html
<!-- Task Progress - Inline below status bar -->
<div id="taskList" class="task-list-inline hidden">
  <!-- Populated by renderTasksInline() -->
</div>
```

2. **Add CSS for inline task list** (~line 280)

```css
.task-list-inline {
  background: var(--bg-secondary);
  border-bottom: 0.5px solid var(--separator);
  padding: 8px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 120px;
  overflow-y: auto;
}
.task-list-inline.hidden { display: none; }

.task-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.task-inline .task-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.task-inline.pending .task-icon::before { content: '○'; color: var(--text-muted); }
.task-inline.in_progress .task-icon::before { content: '◐'; color: var(--accent); }
.task-inline.completed .task-icon::before { content: '●'; color: var(--success); }

.task-inline .task-subject {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.task-inline.completed .task-subject {
  color: var(--text-muted);
  text-decoration: line-through;
}
```

3. **Update renderTasks function** (~line 3324)

```javascript
function renderTasksInline() {
  const container = document.getElementById('taskList');
  if (tasks.size === 0) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = '';

  tasks.forEach((task, id) => {
    const div = document.createElement('div');
    div.className = `task-inline ${task.status}`;
    div.innerHTML = `
      <span class="task-icon"></span>
      <span class="task-subject">${escapeHtml(task.subject)}</span>
    `;
    container.appendChild(div);
  });
}
```

4. **Call renderTasksInline() from handlers** (~lines 3282-3299)

In the `task_create` and `task_update` message handlers, replace `renderTasks()` with `renderTasksInline()`.

---

## Feature 2: Expanded Subagent Dropdown

### Current State
- Badge shows count: "🤖 2"
- Dropdown shows basic list with name and status
- `updateSubagentIndicator()` at line 3363

### Implementation

**File: `public/index.html`**

1. **Enhance subagent-item CSS** (~line 204)

```css
.subagent-item {
  padding: 10px 12px;
  border-bottom: 0.5px solid var(--separator);
}
.subagent-item:last-child { border-bottom: none; }

.subagent-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.subagent-status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.subagent-status.running { background: var(--success); }
.subagent-status.waiting { background: var(--warning); }
.subagent-status.complete { background: var(--text-muted); }

.subagent-name {
  font-weight: 500;
  font-size: 14px;
  flex: 1;
}

.subagent-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-secondary);
}

.subagent-tool {
  color: var(--tool-msg);
}
```

2. **Update updateSubagentIndicator()** (~line 3363)

```javascript
function updateSubagentIndicator() {
  const indicator = document.getElementById('subagentIndicator');
  const countEl = indicator.querySelector('.subagent-count');
  const listEl = indicator.querySelector('.subagent-list');

  const count = activeSubagents.size;
  if (count === 0) {
    indicator.classList.add('hidden');
    return;
  }

  indicator.classList.remove('hidden');
  countEl.textContent = count;

  listEl.innerHTML = '';
  activeSubagents.forEach((agent, id) => {
    const statusClass = agent.status === 'waiting' ? 'waiting' :
                        agent.status === 'complete' ? 'complete' : 'running';
    const toolText = agent.currentTool || 'idle';
    const tokens = `${formatTokens(agent.inputTokens || 0)} in / ${formatTokens(agent.outputTokens || 0)} out`;

    const item = document.createElement('div');
    item.className = 'subagent-item';
    item.innerHTML = `
      <div class="subagent-item-header">
        <span class="subagent-status ${statusClass}"></span>
        <span class="subagent-name">${escapeHtml(agent.description || id.substring(0, 8))}</span>
      </div>
      <div class="subagent-meta">
        <span class="subagent-tool">${escapeHtml(toolText)}</span>
        <span>${tokens}</span>
      </div>
    `;
    listEl.appendChild(item);
  });
}
```

---

## Feature 3: Inline File Diff Preview

### Approach

Use a **proper Longest Common Subsequence (LCS) diff algorithm** to show actual line-by-line differences, matching how Claude Code terminal displays diffs.

### Why This Matters

A proper diff shows:
- **Context lines** (unchanged) - no prefix, gray text
- **Removed lines** - `-` prefix, red background
- **Added lines** - `+` prefix, green background
- **Line numbers** on the left for reference

### Implementation

**File: `public/index.html`**

1. **Add diff CSS** (~line 420)

```css
.diff-preview {
  margin-top: 8px;
  font-family: 'SF Mono', ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.5;
  background: var(--bg-grouped);
  border-radius: 6px;
  overflow: hidden;
  max-height: 200px;
  overflow-y: auto;
}

.diff-line {
  padding: 1px 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.diff-line.context {
  color: var(--text-muted);
}

.diff-line.remove {
  background: rgba(255, 69, 58, 0.15);
  color: #ff6961;
}

.diff-line.add {
  background: rgba(48, 209, 88, 0.15);
  color: #4cd964;
}

.diff-line-number {
  display: inline-block;
  width: 32px;
  color: var(--text-muted);
  text-align: right;
  margin-right: 8px;
  user-select: none;
}

.diff-truncated {
  padding: 8px;
  text-align: center;
  color: var(--text-muted);
  font-style: italic;
}

.tool-path {
  color: var(--text-muted);
  font-size: 12px;
  margin-left: 4px;
}
```

2. **Add proper LCS diff function** (~line 2400)

```javascript
/**
 * Compute diff between two strings using LCS (Longest Common Subsequence)
 * Returns array of {type: 'context'|'add'|'remove', line: string, lineNum?: number}
 */
function computeDiff(oldStr, newStr) {
  const oldLines = (oldStr || '').split('\n');
  const newLines = (newStr || '').split('\n');

  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const diff = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.unshift({ type: 'context', line: oldLines[i - 1], oldNum: i, newNum: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: 'add', line: newLines[j - 1], newNum: j });
      j--;
    } else {
      diff.unshift({ type: 'remove', line: oldLines[i - 1], oldNum: i });
      i--;
    }
  }

  return diff;
}

/**
 * Render diff as HTML with line numbers
 * Shows max lines with context around changes
 */
function renderDiff(oldStr, newStr, maxLines = 20) {
  if (!oldStr && !newStr) return '';

  const diff = computeDiff(oldStr, newStr);

  // Find changed regions and include context
  const contextLines = 2;
  const changedIndices = new Set();

  diff.forEach((d, i) => {
    if (d.type !== 'context') {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(diff.length - 1, i + contextLines); j++) {
        changedIndices.add(j);
      }
    }
  });

  // Build output with limited lines
  let html = '<div class="diff-preview">';
  let shown = 0;
  let skipped = 0;

  diff.forEach((d, i) => {
    if (!changedIndices.has(i)) {
      skipped++;
      return;
    }

    if (shown >= maxLines) {
      return;
    }

    if (skipped > 0 && shown > 0) {
      html += `<div class="diff-truncated">... ${skipped} unchanged lines ...</div>`;
      skipped = 0;
    }

    const prefix = d.type === 'add' ? '+' : d.type === 'remove' ? '-' : ' ';
    const lineNum = d.type === 'remove' ? d.oldNum : d.newNum;

    html += `<div class="diff-line ${d.type}">`;
    html += `<span class="diff-line-number">${lineNum || ''}</span>`;
    html += `${prefix} ${escapeHtml(d.line)}`;
    html += '</div>';

    shown++;
  });

  if (shown >= maxLines && diff.length > shown) {
    html += `<div class="diff-truncated">... ${diff.length - shown} more lines ...</div>`;
  }

  html += '</div>';
  return html;
}
```

3. **Update Edit tool rendering in appendMessage()** (~line 2336)

```javascript
// In appendMessage(), when handling type === 'tool' for Edit
if (data.tool === 'Edit' && data.input?.old_string && data.input?.new_string) {
  const filePath = data.input.file_path || 'file';
  const diffHtml = renderDiff(data.input.old_string, data.input.new_string);

  msg.innerHTML = `
    <div class="tool-summary" data-lang="${escapeHtml(lang)}">
      <span class="tool-chevron">▶</span>
      <span class="tool-name">${escapeHtml(data.tool)}</span>
      <span class="tool-path">${escapeHtml(filePath)}</span>
    </div>
    ${diffHtml}
    <div class="tool-details"><pre>${escapeHtml(fullInput)}</pre></div>
  `;
} else {
  // Existing rendering for other tools...
}
```

---

## Feature 4: Checkpoint Quick Action

### Approach

Delegate to Claude Code's `/rewind` command instead of building custom checkpoint parsing (which would be incorrect - we don't know the actual checkpoint ID format).

### Implementation

**File: `public/index.html`**

1. **Add rewind button to action sheet** (~line 1375)

```html
<button class="action-sheet-btn" onclick="sendPreset('/rewind'); hideActionSheet();">
  ⏪ Rewind (Checkpoints)
</button>
```

Claude Code handles the checkpoint UI correctly.

### Why Not Build Custom UI?

From code review feedback:
- We don't know the actual checkpoint ID format
- User messages ≠ checkpoints (checkpoints are created on file changes)
- Log line indices are unstable and can't be used as IDs
- `/rewind` already provides a proper checkpoint browser

---

## Files to Modify

| File | Section | Changes | Status |
|------|---------|---------|--------|
| `public/index.html` | HTML (~1336) | Add inline task list element | ✅ |
| `public/index.html` | CSS (~280) | Add task list inline styles | ✅ |
| `public/index.html` | CSS (~204) | Enhance subagent dropdown styles | ✅ |
| `public/index.html` | CSS (~420) | Add diff preview styles | ✅ |
| `public/index.html` | JS (~2400) | Add `computeDiff()` and `renderDiff()` | ✅ |
| `public/index.html` | JS (~2336) | Update Edit tool rendering for diffs | ✅ |
| `public/index.html` | JS (~3282) | Update task handlers to call `renderTasksInline()` | ✅ |
| `public/index.html` | JS (~3324) | Replace `renderTasks()` with `renderTasksInline()` | ✅ |
| `public/index.html` | JS (~3363) | Enhance `updateSubagentIndicator()` | ✅ |
| `public/index.html` | HTML (~1375) | Add Rewind button to action sheet | ✅ |

**No server.js changes needed** - all features work with existing infrastructure.

---

## Verification

### Feature 1: Tasks
1. Start a Claude session that creates tasks
2. Verify inline list appears below status bar
3. Verify status icons update (○ → ◐ → ●)
4. Verify list hides when all tasks complete

### Feature 2: Subagents
1. Trigger a Task tool call (subagent)
2. Verify badge shows count
3. Tap badge, verify dropdown shows: name, current tool, token usage
4. Verify status indicator updates (green running, yellow waiting, gray complete)

### Feature 3: Diffs
1. Trigger an Edit tool call
2. Verify diff preview shows inline with:
   - Line numbers on left
   - `-` prefix and red background for removed lines
   - `+` prefix and green background for added lines
   - Context lines (unchanged) in gray
3. Verify large diffs are truncated with "... N more lines ..."
4. Chevron still expands to full JSON

### Feature 4: Rewind
1. Tap ⋮ menu
2. Select "⏪ Rewind (Checkpoints)"
3. Verify `/rewind` command is sent to Claude
4. Claude Code's checkpoint browser appears in session

---

## References

- [Brainstorm document](../brainstorms/2026-01-28-terminal-parity-improvements-brainstorm.md)
- [Claude Code Text Editor Tool Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool)
- [jsdiff npm package](https://www.npmjs.com/package/diff) (reference for LCS algorithm)
