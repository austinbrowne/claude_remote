---
title: "feat: Mobile Visibility and Permission Enhancements"
type: feat
date: 2026-01-27
priority: high
---

# Mobile Visibility and Permission Enhancements

## Overview

Enhance the mobile app to provide feature parity with Claude Code terminal for:
1. Permission prompts (WebFetch, MCP tools, "Always Allow")
2. Status indicators (verbs, token usage)
3. Progress visibility (tasks, subagent details)

## Related Todos

| ID | Priority | Issue |
|----|----------|-------|
| 044 | P1 | WebFetch permission prompts |
| 042 | P2 | Subagent names, tools, token usage |
| 043 | P2 | Status verbs and token usage |
| 045 | P2 | Task progress with checkboxes |
| 047 | P2 | "Always Allow" for permissions |
| 046 | P3 | MCP plugin permission prompts |

---

## Phase 1: Permission System Fixes (P1)

### 1.1 Add WebFetch and NotebookEdit to Permission Detection

**File:** `server.js` - `parseLogEntry()` function (line 668)

**Current code:**
```javascript
else if (['Bash', 'Write', 'Edit', 'MultiEdit'].includes(block.name)) {
```

**Change to:**
```javascript
const PERMISSION_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'NotebookEdit'];
// ...
else if (PERMISSION_TOOLS.includes(block.name)) {
```

- [x] Add `WebFetch` to permission-triggering tools
- [x] Add `NotebookEdit` for completeness
- [x] Extract tool list to constant for maintainability

### 1.2 Add MCP Tool Detection

**File:** `server.js` - `parseLogEntry()` function (line 668)

```javascript
const PERMISSION_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'NotebookEdit'];
const isMcpTool = block.name.startsWith('mcp__');

if (PERMISSION_TOOLS.includes(block.name) || isMcpTool) {
  console.log(`[Permission] Detected ${block.name} tool call`);
  results.push({
    type: 'permission_request',
    tool: isMcpTool ? formatMcpToolName(block.name) : block.name,
    input: isMcpTool ? sanitizeMcpInput(block.input) : block.input,
    timestamp
  });
}

// Add at module level:
function formatMcpToolName(name) {
  // mcp__github__create_issue -> GitHub: create_issue
  const parts = name.split('__');
  if (parts.length >= 3) {
    const server = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    return `${server}: ${parts.slice(2).join('_')}`;
  }
  return name;
}

function sanitizeMcpInput(input) {
  // Redact potentially sensitive fields from MCP tool inputs
  if (!input) return {};
  const safe = { ...input };
  const sensitiveKeys = ['password', 'token', 'secret', 'key', 'auth', 'credential'];
  for (const key of Object.keys(safe)) {
    if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
      safe[key] = '[REDACTED]';
    }
  }
  return safe;
}
```

- [x] Detect `mcp__` prefixed tool names
- [x] Format MCP tool names for readability
- [x] Sanitize MCP input to hide sensitive fields
- [x] Show MCP tool input in permission card

### 1.3 Add "Always Allow" Button

**File:** `public/index.html` - `showPromptCard()` function

Claude Code uses numbered options for permissions:
- `1` = Yes (always allow this tool)
- `2` = Yes, during this session
- `3` or `esc` = No

**Scope definition:** "Always Allow" persists for the current Claude session only. The approval is for the specific tool type (e.g., "Bash", "WebFetch") not specific commands. User can revoke via Settings panel.

**Current buttons:**
```html
<button onclick="respondToPrompt('y')">Yes</button>
<button onclick="respondToPrompt('n')">No</button>
```

**Change to:**
```html
<button onclick="respondToPrompt('1')" class="btn-allow-always">Always Allow</button>
<button onclick="respondToPrompt('2')" class="btn-primary">Yes (this time)</button>
<button onclick="respondToPrompt('3')" class="btn-secondary">No</button>
```

**CSS:**
```css
.btn-allow-always {
  background: var(--success);
  color: white;
  font-weight: 600;
}
```

- [x] Change "Yes" to send `1` for always-allow
- [x] Add "Yes (this time)" button sending `2`
- [x] Change "No" to send `3`
- [x] Style "Always Allow" button distinctly
- [ ] Test that subsequent requests auto-approve

### 1.4 Format Permission Display by Tool Type

**File:** `public/index.html` - `showPromptCard()` function

```javascript
function formatPermissionDisplay(tool, input) {
  switch(tool) {
    case 'Bash':
      return input?.command || 'Run command';
    case 'WebFetch':
      return sanitizeUrl(input?.url) || 'Fetch URL';
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return input?.file_path || 'Modify file';
    case 'NotebookEdit':
      return input?.notebook_path || 'Edit notebook';
    default:
      // MCP tools - show truncated JSON input
      return JSON.stringify(input, null, 2).substring(0, 200) + '...';
  }
}

function sanitizeUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    // Strip query params to avoid leaking tokens/keys
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}
```

- [x] Format WebFetch to show sanitized URL (no query params)
- [x] Format MCP tools to show relevant input fields
- [x] Truncate long inputs with ellipsis

### 1.5 Add Permission Revocation (Settings)

**File:** `public/index.html` - Add settings section

```html
<div id="settingsPanel" class="settings-panel hidden">
  <h3>Permissions</h3>
  <div id="allowedToolsList"></div>
  <button onclick="revokeAllPermissions()">Revoke All</button>
</div>
```

```javascript
// Track locally which tools have been always-allowed
const alwaysAllowedTools = new Set();

function trackAlwaysAllow(tool) {
  alwaysAllowedTools.add(tool);
  updateSettingsPanel();
}

function revokeAllPermissions() {
  alwaysAllowedTools.clear();
  // Note: This only clears local tracking. Claude Code manages actual permissions.
  updateSettingsPanel();
}
```

**Note:** Actual permission state is managed by Claude Code. This UI tracks what was approved from mobile for user awareness only.

- [ ] Add settings panel with permission list
- [ ] Track always-allowed tools locally
- [ ] Show "Revoke All" button
- [ ] Add settings icon to header

---

## Phase 2: Status and Token Visibility (P2)

### 2.1 Parse Progress Entries

**File:** `server.js` - `parseLogEntry()` function (line 638)

Currently we skip progress entries. Change to broadcast them:

```javascript
// Handle progress entries - broadcast status updates
if (entry.type === 'progress') {
  return [{
    type: 'status_update',
    text: entry.message || entry.status || 'Working...',
    timestamp: entry.timestamp || new Date().toISOString()
  }];
}
```

- [x] Change progress handling from skip to broadcast
- [x] Extract status text from message field
- [x] Broadcast to clients

### 2.2 Track Token Usage

**File:** `server.js` - `parseLogEntry()` function

Add token extraction after assistant message processing (around line 695):

```javascript
// Extract token usage from assistant messages
if (entry.type === 'assistant' && entry.message?.usage) {
  results.push({
    type: 'token_usage',
    input: entry.message.usage.input_tokens || 0,
    output: entry.message.usage.output_tokens || 0,
    cacheRead: entry.message.usage.cache_read_input_tokens || 0,
    cacheWrite: entry.message.usage.cache_creation_input_tokens || 0,
    timestamp
  });
}
```

- [x] Parse `usage` field from assistant messages
- [x] Include cache token counts
- [x] Broadcast token updates to clients

### 2.3 Add Status Bar UI

**File:** `public/index.html`

**HTML (after header, before main content):**
```html
<div id="statusBar" class="status-bar hidden">
  <div class="status-text">
    <span class="status-icon spinner"></span>
    <span id="statusVerb">Working...</span>
  </div>
  <div class="token-usage">
    <span id="tokenInput">0</span> in / <span id="tokenOutput">0</span> out
  </div>
</div>
```

**CSS:**
```css
.status-bar {
  background: var(--bg-secondary);
  padding: 8px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border);
  font-size: 0.85rem;
}
.status-bar.hidden { display: none; }
.token-usage { color: var(--text-secondary); font-family: monospace; }
.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--text-secondary);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
```

**JavaScript (add to message handler):**
```javascript
let sessionTokens = { input: 0, output: 0 };
let statusTimeout = null;

function handleStatusUpdate(data) {
  const statusBar = document.getElementById('statusBar');
  const statusVerb = document.getElementById('statusVerb');

  statusBar.classList.remove('hidden');
  statusVerb.textContent = data.text;

  // Auto-hide after 5 seconds of no updates
  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => {
    statusBar.classList.add('hidden');
  }, 5000);
}

function handleTokenUsage(data) {
  sessionTokens.input += data.input;
  sessionTokens.output += data.output;

  document.getElementById('tokenInput').textContent = formatTokens(sessionTokens.input);
  document.getElementById('tokenOutput').textContent = formatTokens(sessionTokens.output);
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toString();
}

function resetSessionTokens() {
  sessionTokens = { input: 0, output: 0 };
  document.getElementById('tokenInput').textContent = '0';
  document.getElementById('tokenOutput').textContent = '0';
}
```

- [x] Add status bar HTML element
- [x] Style status bar for mobile
- [x] Handle `status_update` messages
- [x] Handle `token_usage` messages
- [x] Accumulate tokens per session
- [x] Format large numbers (k, M)
- [x] Auto-hide status bar after inactivity
- [x] Reset tokens on session switch

---

## Phase 3: Task Progress UI (P2)

### 3.1 Parse Task Tool Calls

**File:** `server.js` - `parseLogEntry()` function

Add task tool detection in the tool_use handling block (after line 686):

```javascript
// Task management tools
if (block.name === 'TaskCreate') {
  results.push({
    type: 'task_create',
    id: 'pending-' + Date.now(), // Temporary ID until we get result
    subject: block.input?.subject,
    description: block.input?.description,
    activeForm: block.input?.activeForm,
    status: 'pending'
  });
}

if (block.name === 'TaskUpdate') {
  results.push({
    type: 'task_update',
    id: block.input?.taskId,
    status: block.input?.status,
    subject: block.input?.subject
  });
}

if (block.name === 'TaskList') {
  results.push({
    type: 'task_list_request',
    timestamp
  });
}
```

**Parse TaskList results from tool_result entries:**
```javascript
// In the tool_result handling section, add:
if (entry.toolName === 'TaskList' && entry.toolUseResult?.content) {
  const tasks = parseTaskListResult(entry.toolUseResult.content);
  if (tasks.length > 0) {
    results.push({
      type: 'task_list',
      tasks
    });
  }
}

function parseTaskListResult(content) {
  // TaskList returns markdown-formatted task list
  // Parse lines like: "- [x] Task subject (id: abc123)"
  // or structured JSON depending on format
  const tasks = [];

  if (typeof content === 'string') {
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^[-*]\s*\[([ x])\]\s*(.+?)(?:\s*\(id:\s*(\w+)\))?$/);
      if (match) {
        tasks.push({
          id: match[3] || 'unknown',
          subject: match[2].trim(),
          status: match[1] === 'x' ? 'completed' : 'pending'
        });
      }
    }
  }

  return tasks;
}
```

- [x] Detect TaskCreate tool calls
- [x] Detect TaskUpdate tool calls
- [x] Detect TaskList results
- [x] Implement `parseTaskListResult()` for markdown format
- [x] Extract task IDs, subjects, statuses

### 3.2 Add Task Panel UI

**File:** `public/index.html`

**HTML (before output area):**
```html
<div id="taskPanel" class="task-panel hidden">
  <div class="task-header" onclick="toggleTaskPanel()">
    <span>Tasks</span>
    <span id="taskProgress">0/0</span>
    <span class="expand-icon">&#9660;</span>
  </div>
  <div id="taskList" class="task-list"></div>
</div>
```

**CSS:**
```css
.task-panel {
  background: var(--bg-secondary);
  border-radius: 8px;
  margin: 8px;
  overflow: hidden;
}
.task-panel.hidden { display: none; }
.task-header {
  padding: 12px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  font-weight: 600;
}
.task-list {
  padding: 0 16px 12px;
  max-height: 200px;
  overflow-y: auto;
}
.task-list.collapsed { display: none; }
.task-item {
  padding: 6px 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9rem;
}
.task-item.completed { color: var(--text-secondary); }
.task-item.in_progress { color: var(--accent); }
.task-checkbox {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.task-checkbox.checked {
  background: var(--success);
  border-color: var(--success);
  color: white;
}
.task-checkbox.in-progress {
  border-color: var(--accent);
}
```

**JavaScript:**
```javascript
const tasks = new Map(); // id -> { subject, status, description, activeForm }
let taskPanelExpanded = true;

function handleTaskCreate(data) {
  tasks.set(data.id, {
    subject: data.subject,
    status: data.status || 'pending',
    description: data.description,
    activeForm: data.activeForm
  });
  renderTasks();
}

function handleTaskUpdate(data) {
  const task = tasks.get(data.id);
  if (task) {
    if (data.status) task.status = data.status;
    if (data.subject) task.subject = data.subject;
    renderTasks();
  }
}

function handleTaskList(data) {
  // Replace all tasks with the authoritative list
  tasks.clear();
  for (const task of data.tasks) {
    tasks.set(task.id, {
      subject: task.subject,
      status: task.status,
      description: task.description || ''
    });
  }
  renderTasks();
}

function toggleTaskPanel() {
  taskPanelExpanded = !taskPanelExpanded;
  const list = document.getElementById('taskList');
  const icon = document.querySelector('.task-panel .expand-icon');
  list.classList.toggle('collapsed', !taskPanelExpanded);
  icon.innerHTML = taskPanelExpanded ? '&#9660;' : '&#9654;';
}

function renderTasks() {
  const panel = document.getElementById('taskPanel');
  const list = document.getElementById('taskList');
  const progress = document.getElementById('taskProgress');

  if (tasks.size === 0) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');

  const completed = [...tasks.values()].filter(t => t.status === 'completed').length;
  const inProgress = [...tasks.values()].filter(t => t.status === 'in_progress').length;
  progress.textContent = `${completed}/${tasks.size}`;

  list.innerHTML = [...tasks.entries()].map(([id, task]) => {
    const checkboxClass = task.status === 'completed' ? 'checked' :
                          task.status === 'in_progress' ? 'in-progress' : '';
    const checkmark = task.status === 'completed' ? '&#10003;' :
                      task.status === 'in_progress' ? '&#8226;' : '';
    return `
      <div class="task-item ${task.status}">
        <div class="task-checkbox ${checkboxClass}">${checkmark}</div>
        <span>${escapeHtml(task.subject)}</span>
      </div>
    `;
  }).join('');
}

function clearTasks() {
  tasks.clear();
  renderTasks();
}
```

- [x] Add task panel HTML
- [x] Style task panel for mobile
- [x] Track tasks in Map
- [x] Handle task_create messages
- [x] Handle task_update messages
- [x] Handle task_list messages
- [x] Render task list with checkbox icons
- [x] Show progress count (completed/total)
- [x] Make panel collapsible
- [x] Clear tasks on session switch

---

## Phase 4: Enhanced Subagent Details (P2)

### 4.1 Extract Subagent Description from Task Tool

**File:** `server.js` - `parseLogEntry()` function

When Task tool is called in main session, extract and store the description:

```javascript
// Track pending subagent descriptions by correlation
const pendingSubagentDescriptions = new Map(); // timestamp -> description

if (block.name === 'Task') {
  const agentDescription = block.input?.description || 'Subagent';
  const agentType = block.input?.subagent_type || 'general';

  // Store with timestamp for correlation
  pendingSubagentDescriptions.set(Date.now(), {
    description: agentDescription,
    type: agentType
  });

  // Cleanup old entries after 30 seconds
  setTimeout(() => {
    pendingSubagentDescriptions.forEach((v, k) => {
      if (Date.now() - k > 30000) pendingSubagentDescriptions.delete(k);
    });
  }, 30000);

  results.push({
    type: 'subagent_starting',
    description: agentDescription,
    agentType: agentType,
    timestamp
  });
}
```

**Correlation approach:** When a new subagent file appears, match it to the most recent pending description by timing (within 5 seconds of Task call).

- [x] Extract description from Task tool calls
- [x] Store pending descriptions with timestamps
- [x] Emit subagent_starting event
- [x] Correlate with subagent file creation by timing

### 4.2 Track Subagent Tool Usage and Tokens

**File:** `server.js` - `watchSubagent()` function

In the subagent log parsing, extract and broadcast tool usage and tokens:

```javascript
// In processSubagentEntry function:
function processSubagentEntry(entry, sessionId, agentId) {
  const results = [];

  // Tool usage from subagent
  if (entry.type === 'assistant' && entry.message?.content) {
    for (const block of entry.message.content) {
      if (block.type === 'tool_use') {
        broadcastToClients({
          type: 'subagent_tool',
          sessionId,
          agentId,
          tool: block.name,
          input: block.input
        });
      }
    }
  }

  // Token usage from subagent
  if (entry.type === 'assistant' && entry.message?.usage) {
    broadcastToClients({
      type: 'subagent_tokens',
      sessionId,
      agentId,
      input: entry.message.usage.input_tokens || 0,
      output: entry.message.usage.output_tokens || 0
    });
  }

  return results;
}
```

- [x] Broadcast subagent tool usage
- [x] Include tool name and relevant input
- [x] Parse token usage from subagent logs
- [x] Broadcast token updates to clients
- [x] Accumulate per-subagent

### 4.3 Enhanced Subagent Panel UI

**File:** `public/index.html`

**Update activeSubagents data structure:**
```javascript
// Existing: activeSubagents = new Map()
// Change value structure to include more details:
// id -> { description, type, status, startTime, currentTool, inputTokens, outputTokens }
```

**Update subagent message handlers:**
```javascript
function handleSubagentStarting(data) {
  // Correlate with subagent that appears shortly after
  pendingSubagentInfo = {
    description: data.description,
    type: data.agentType,
    timestamp: Date.now()
  };
}

function handleSubagentStart(data) {
  const info = pendingSubagentInfo || {};
  activeSubagents.set(data.agentId, {
    description: info.description || data.agentId.substring(0, 8),
    type: info.type || 'general',
    status: 'active',
    startTime: Date.now(),
    currentTool: null,
    inputTokens: 0,
    outputTokens: 0
  });
  pendingSubagentInfo = null;
  renderSubagentPanel();
}

function handleSubagentTool(data) {
  const agent = activeSubagents.get(data.agentId);
  if (agent) {
    agent.currentTool = data.tool;
    renderSubagentPanel();
  }
}

function handleSubagentTokens(data) {
  const agent = activeSubagents.get(data.agentId);
  if (agent) {
    agent.inputTokens += data.input;
    agent.outputTokens += data.output;
    renderSubagentPanel();
  }
}

function renderSubagentPanel() {
  const panel = document.getElementById('subagentPanel');

  if (activeSubagents.size === 0) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="subagent-header">Subagents (${activeSubagents.size})</div>
    <div class="subagent-list">
      ${[...activeSubagents.entries()].map(([id, agent]) => `
        <div class="subagent-item">
          <div class="subagent-name">${escapeHtml(agent.description)}</div>
          <div class="subagent-activity">
            ${agent.currentTool ? `Using: ${agent.currentTool}` : 'Working...'}
          </div>
          <div class="subagent-tokens">
            ${formatTokens(agent.inputTokens)} in / ${formatTokens(agent.outputTokens)} out
          </div>
        </div>
      `).join('')}
    </div>
  `;
}
```

**CSS:**
```css
.subagent-panel {
  background: var(--bg-secondary);
  border-radius: 8px;
  margin: 8px;
  overflow: hidden;
}
.subagent-panel.hidden { display: none; }
.subagent-header {
  padding: 12px 16px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}
.subagent-list {
  padding: 8px 16px;
}
.subagent-item {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.subagent-item:last-child { border-bottom: none; }
.subagent-name {
  font-weight: 500;
  margin-bottom: 4px;
}
.subagent-activity {
  font-size: 0.85rem;
  color: var(--accent);
}
.subagent-tokens {
  font-size: 0.8rem;
  color: var(--text-secondary);
  font-family: monospace;
  margin-top: 2px;
}
```

- [x] Show subagent description/name instead of hex ID
- [x] Show current tool being used
- [x] Show per-subagent token usage
- [x] Update panel in real-time

---

## Implementation Order

1. **Phase 1.1-1.2**: WebFetch + MCP permission detection (P1 security fix)
2. **Phase 1.3-1.4**: Always Allow button + formatting
3. **Phase 1.5**: Permission revocation UI
4. **Phase 2**: Status bar with verbs and tokens
5. **Phase 3**: Task progress panel
6. **Phase 4**: Enhanced subagent details

## Files to Modify

| File | Line | Changes |
|------|------|---------|
| `server.js` | 633-640 | Change progress handling to broadcast |
| `server.js` | 668 | Add WebFetch, NotebookEdit, MCP detection |
| `server.js` | ~695 | Add token usage extraction |
| `server.js` | ~686 | Add Task tool parsing |
| `server.js` | module level | Add formatMcpToolName, sanitizeMcpInput, parseTaskListResult |
| `server.js` | watchSubagent() | Add tool and token broadcasting |
| `public/index.html` | CSS | Add status bar, task panel, subagent panel styles |
| `public/index.html` | HTML | Add status bar, task panel, settings panel |
| `public/index.html` | JS | Add handlers for new message types |
| `public/index.html` | showPromptCard() | Update buttons for 1/2/3 options |

## Testing

1. **Permissions**: Trigger WebFetch, MCP tool calls - verify prompts appear
2. **Always Allow**: Approve with option 1 - verify subsequent auto-approve
3. **Permission display**: Verify URLs sanitized (no query params), MCP inputs filtered
4. **Status**: Run long operation - verify status verb and tokens update
5. **Tasks**: Run `/workflows:work` - verify task checkboxes appear and update
6. **Subagents**: Run code review with agents - verify names, tools, tokens visible
7. **Settings**: Verify permission list shows, revoke clears local tracking

## Acceptance Criteria

- [x] All permission-requiring tools prompt on mobile (Bash, Edit, Write, MultiEdit, WebFetch, NotebookEdit, MCP)
- [x] "Always Allow" (option 1) enables future auto-approval for that tool
- [x] Permission displays sanitize sensitive data (URLs, MCP inputs)
- [ ] Settings panel shows allowed tools with revoke option (deferred - local tracking only)
- [x] Status verbs visible while Claude works
- [x] Token usage displayed and updating
- [x] Task progress shown with checkboxes
- [x] Subagent names (not hex IDs), tools, and tokens visible
