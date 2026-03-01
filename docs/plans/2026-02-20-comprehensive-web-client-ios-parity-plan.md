---
title: "Web Client iOS Feature Parity"
tier: comprehensive
status: in_progress
date: 2026-02-20
tags: [web, frontend, parity, ui, vanilla-js]
security_sensitive: false
risk_flags: []
---

# Comprehensive Plan: Web Client iOS Feature Parity

## Problem

The web client (`public/`) has fallen significantly behind the iOS app in feature coverage. Users who access Claude Remote via browser get a degraded experience — missing context visualization, no file browsing, weaker prompt handling, no milestones, and no markdown rendering. The server already exposes all necessary WebSocket messages and REST endpoints; this is purely a frontend gap.

## Goals

1. Achieve functional parity with iOS for all major user-facing features
2. Follow existing web client patterns (vanilla JS, CSS variables, overlay/sheet conventions)
3. Maintain mobile-first responsive design
4. No new dependencies (keep vanilla JS, lazy-load markdown library like Prism)

## Solution Overview

11 features organized into 4 priority tiers based on user impact:

**Tier 1 — High-Impact Visibility** (context ring, session status, markdown)
**Tier 2 — Missing Functionality** (document browser, clear & resume, plan exit prompts)
**Tier 3 — Enhanced Interactions** (prompt queue improvements, task list sheet, select_option/select_other, catch_up)
**Tier 4 — Polish** (milestones timeline)

## Technical Approach

### Architecture Principles
- Follow existing overlay/sheet pattern: overlay div + content div, `.show` class toggle
- State in module-scoped globals (`state.js`)
- WebSocket handlers in `connection.js` — use message dispatcher map (see Structural Improvements below) instead of growing monolithic switch
- UI rendering: plain text → `escapeHtml()`, rich content (markdown) → `DOMPurify.sanitize(marked.parse(...))` as an atomic expression. Never use `innerHTML` with unsanitized content.
- CSS variables for all colors, iOS cubic-bezier easing
- Event delegation for dynamic content

### Structural Improvements (Applied Across Phases)

**Finding: `connection.js` switch growing monolithic (MEDIUM).** Extract message handlers into a dispatcher map to avoid a 200+ line switch:
```javascript
const messageHandlers = {
  context_percentage: handleContextPercentage,
  session_status: handleSessionStatus,
  clear_and_resume_progress: handleClearResumeProgress,
  session_replaced: handleSessionReplaced,
  session_milestone: handleMilestone,
  // ... existing handlers stay as functions
};
// In onmessage:
const handler = messageHandlers[msg.type];
if (handler) handler(msg); else console.warn('Unknown message type:', msg.type);
```

**Finding: `ui.js` growing monolithic (MEDIUM).** Group functions by feature domain with clear section headers. If the file exceeds ~600 lines after all phases, split into: `ui-context.js`, `ui-docviewer.js`, `ui-milestones.js`, `ui-tasks.js`. Each module attaches to the global scope (no build toolchain needed).

### Past Learnings Applied
- **XSS prevention**: Use `JSON.stringify()` for JS-in-HTML contexts, not just `escapeHtml()` (from `xss-inline-onclick-tool-names` solution)
- **Permission queue**: Scope dismissal by `toolUseId`, never nuke entire queue (from `parallel-agent-permission-queue` solution)
- **Prompt false positives**: 500ms delay pattern with cancellation (from integration patterns solution)
- **Multi-select injection**: Tab before Enter for Ink Submit, 300-400ms delays (from multiselect solution)

## Implementation Steps

### Phase 1: Context Ring & Percentage Display

**Files:** `index.html`, `styles.css`, `connection.js`, `ui.js`

**1a. HTML** — Add context ring to header (after subagent indicator). **Initial state: hidden until first `context_percentage` received** (Finding #7):
```html
<div class="context-ring" id="contextRing" onclick="showContextSheet()" style="display:none">
  <svg viewBox="0 0 36 36" class="context-ring-svg">
    <circle class="context-ring-bg" cx="18" cy="18" r="15.915"/>
    <circle class="context-ring-fill" id="contextRingFill" cx="18" cy="18" r="15.915"
      stroke-dasharray="0 100" stroke-dashoffset="25"/>
  </svg>
  <span class="context-ring-text" id="contextRingText">0%</span>
</div>
```

**1b. Context Detail Sheet** — New sheet (follow subagent sheet pattern):
```html
<div class="context-sheet-overlay" id="contextSheetOverlay" onclick="hideContextSheet()"></div>
<div class="context-sheet" id="contextSheet">
  <!-- Large ring, status, mode, subagent count, remaining tokens -->
  <!-- /compact button (shown when >= 80%) -->
  <!-- Clear & Resume button -->
</div>
```

**1c. CSS** — Ring styles with SVG stroke-dasharray animation, green/orange/red thresholds:
- Green: < 70%, Orange: 70-90%, Red: >= 90%
- Ring is 22x22px in header, 100x100px in sheet
- Sheet follows existing sheet pattern (slide-up, overlay + content)

**1d. JS** — Handle `context_percentage` in dispatcher map:
```javascript
function handleContextPercentage(msg) {
  // Show ring on first message (hidden initially)
  document.getElementById('contextRing').style.display = '';
  updateContextRing(msg.percentage);
}
```
Add `updateContextRing(pct)` in `ui.js` that updates SVG stroke-dasharray and color class.

### Phase 2: Enhanced Session Status

**Files:** `index.html`, `styles.css`, `connection.js`, `ui.js`

**2a.** Add status text element next to session label (mobile) and dropdown (desktop):
```html
<span class="session-status-text" id="sessionStatusText"></span>
```

**2b.** In `handleMessage` for `session_status` and `status_update`, update text:
- Processing/active: show current activity verb or "Processing"
- Waiting: "Waiting for input"
- Idle: show branch name (from session data) or hide

**2c.** CSS: small caption text, color matches status dot (blue/orange/gray).

### Phase 3: Markdown Rendering in Assistant Messages

**Files:** `index.html`, `ui.js`, `styles.css`

**3a. CDN Loading with SRI & Fallback (Findings #1, #4)**

Load marked.js and DOMPurify with pinned versions and SRI integrity hashes in `index.html`:
```html
<script src="https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js"
  integrity="sha384-[hash]" crossorigin="anonymous"
  onerror="window._markedFailed=true"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js"
  integrity="sha384-[hash]" crossorigin="anonymous"
  onerror="window._dompurifyFailed=true"></script>
```

**Fallback**: If either CDN fails, set a global flag. The rendering path checks both are available before using rich rendering. **If CDN is a persistent concern, self-host both libraries in `public/vendor/`.**

**3b. Rendering — Gate on BOTH libraries loaded (Finding #1)**

Track readiness state. All 4 CDN states are handled:
```javascript
function renderAssistantContent(content) {
  const markedReady = window.marked && !window._markedFailed;
  const purifyReady = window.DOMPurify && !window._dompurifyFailed;

  if (markedReady && purifyReady) {
    // BOTH available: render markdown + sanitize (atomic expression)
    return DOMPurify.sanitize(marked.parse(content, { breaks: true }));
  }
  // ANY missing (marked only, DOMPurify only, neither): safe fallback
  return escapeHtml(content);
}
```
Usage: `msg.innerHTML = renderAssistantContent(data.content);`

**3c.** CSS: Style rendered markdown (headers, lists, code blocks, links) within `.message.assistant`.
- Code blocks: monospace, dark background, copy button
- Links: accent color, external links open in new tab
- Tables: bordered, alternating rows

**3d. DOMPurify Configuration (Finding #15)**

Configure explicit allowlist — don't rely on defaults:
```javascript
const PURIFY_CONFIG = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'h1', 'h2', 'h3', 'h4',
    'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'blockquote', 'hr', 'del', 'img', 'span', 'div', 'sup', 'sub'],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id'],
  FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['target'],  // For links opening in new tab
};
// Block javascript: URIs explicitly
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.hasAttribute('href')) {
    const val = node.getAttribute('href');
    if (val && val.match(/^\s*javascript:/i)) {
      node.removeAttribute('href');
    }
  }
});
// Usage: DOMPurify.sanitize(marked.parse(content), PURIFY_CONFIG);
```

### Phase 4: Document/File Browser

**Files:** `index.html`, `styles.css`, `ui.js` (new functions), `connection.js`

**4a. HTML** — Add document viewer button to header (visible when session active):
```html
<button class="header-btn" id="docViewerBtn" onclick="showDocumentViewer()" style="display:none">
  <svg><!-- doc icon --></svg>
</button>
```

**4b. Document Viewer Sheet** — Full-screen sheet (follow settings panel pattern but full-height):
```html
<div class="doc-viewer-overlay" id="docViewerOverlay" onclick="hideDocumentViewer()"></div>
<div class="doc-viewer" id="docViewer">
  <div class="doc-viewer-header">
    <button onclick="docViewerBack()">Back</button>
    <span id="docViewerPath">Files</span>
    <button onclick="hideDocumentViewer()">Done</button>
  </div>
  <div class="doc-viewer-content" id="docViewerContent"></div>
</div>
```

**4c. JS Functions:**
- `showDocumentViewer()` — Open sheet, load root directory via REST
- `loadDirectory(path)` — `GET /api/files?sessionId=X&path=Y` with auth header, render file list
- `loadFile(path)` — `GET /api/file?sessionId=X&path=Y`, render with syntax highlighting
- `docViewerBack()` — Navigate up (maintain breadcrumb stack)
- File icons by extension (reuse iOS pattern: swift, js, json, md, etc.)
- Copy button for file content
- Markdown rendering for `.md` files (reuse Phase 3 library)

**4d. CSS:** Full-height sheet, file list with icons, code display area with syntax highlighting, breadcrumb path.

### Phase 5: Clear & Resume

**Files:** `index.html`, `styles.css`, `connection.js`, `ui.js`, `state.js`

**5a.** Add "Clear & Resume" button to context detail sheet (from Phase 1).

**5b.** Handle WebSocket messages in dispatcher:
```javascript
messageHandlers['clear_and_resume_progress'] = handleClearResumeProgress;
messageHandlers['session_replaced'] = handleSessionReplaced;
```

**5c.** Send action: `{ action: 'clear_and_resume', sessionId }`.

**5d.** Progress UI with per-step rollback tracking (Finding #2):

State machine with recovery at each step:
```javascript
// state.js
clearResumeState: 'idle', // idle | savingState | clearing | switching | error
clearResumeError: null,

// ui.js
function handleClearResumeProgress(msg) {
  state.clearResumeState = msg.step; // 'savingState' | 'clearing' | 'switching'
  updateClearResumeOverlay(msg.step, msg.message);
}

function handleClearResumeError(msg) {
  state.clearResumeState = 'error';
  state.clearResumeError = msg.message;
  // Show error in overlay with retry/dismiss options
  showClearResumeError(msg.message, msg.step);
}
```

**Rollback behavior per step:**
| Step | On Failure | Recovery |
|------|-----------|----------|
| savingState | State not yet modified | Dismiss overlay, show toast "Save failed — session unchanged" |
| clearing | State saved but clear failed | Offer "Retry clear" or "Cancel" (state file exists for retry) |
| switching | Old session cleared, new session create failed | Show error "Session cleared but new session failed. Refresh to reconnect." |

**5e.** Reuse compaction overlay pattern with different text + error state variant.

**5f.** On `session_replaced`: Update session list, switch to new session, load history.

**5g.** Safety timeout: 90s max, then show error state (not silent dismiss).

### Phase 6: Plan Exit Prompts

**Files:** `prompts.js`, `styles.css`

**6a.** In prompt detection, handle `exit_plan_mode` type from `claude_output`:
```javascript
if (data.type === 'exit_plan_mode') {
  showPromptCard({
    type: 'planExit',
    text: 'Plan mode is ending. How would you like to proceed?',
    options: [
      { label: 'Preserve context and continue', value: '1' },
      { label: 'Clear context and start fresh', value: '2' },
      { label: 'Manual approve (review plan first)', value: '3' },
      { label: 'Request changes to the plan', value: '4' }
    ]
  });
}
```

**6b.** Add `planExit` rendering in `showPromptCard()` — render as multi-choice with 4 options.

**6c.** Response: Use `select_option` action with index (0-3) instead of injecting raw text.

### Phase 7: Improved Prompt Card Queue

**Files:** `prompts.js`, `styles.css`, `index.html`

**7a. Stacked Cards** — Show up to 3 cards (current + 2 peeking behind):
```css
.prompt-card.show { transform: translateY(0); }
.prompt-card-peek-1 { transform: translateY(8px) scale(0.96); opacity: 0.7; }
.prompt-card-peek-2 { transform: translateY(16px) scale(0.92); opacity: 0.5; }
```

**7b. Queue Counter** — "+N more" badge when queue > 3.

**7c. Staleness Badge & Manual Dismiss (Finding #11)** — Track messages since prompt was shown. After 2+ new messages, show "stale" indicator. CSS: small orange badge "May be outdated". Each card gets a dismiss/X button. **Manual dismiss sends a denial to the server** (not just removes UI):
```javascript
function dismissStalePrompt(card) {
  const toolUseId = card.dataset.toolUseId;
  if (toolUseId) {
    // Send denial so Claude Code doesn't hang waiting
    wsSend({ action: 'inject', sessionId: currentSessionId, command: 'n', toolUseId });
  }
  removePromptCard(card);
}
```

**7d. Auto-removal with server denial (Finding #5)** — After 30+ messages with no interaction, auto-remove stale permissions (not questions). **Must send denial to server on auto-remove to prevent deadlocks:**
```javascript
function autoRemoveStalePermissions() {
  promptQueue.forEach(card => {
    if (card.type === 'permission' && card.messagesSinceShown >= 30) {
      // Send denial before removing — prevents server-side hang
      wsSend({ action: 'inject', sessionId: currentSessionId, command: 'n', toolUseId: card.toolUseId });
      removePromptCard(card);
    }
  });
}
```

**7e.** Use `permission_resolved` message to dismiss specific cards by `toolUseId`.

### Phase 8: Task List Sheet

**Files:** `index.html`, `styles.css`, `ui.js`

**8a.** Convert inline task list to tappable element that opens a full sheet.

**8b. Task Sheet** (follow subagent sheet pattern):
- Header with progress bar (completed/total)
- Task rows with status icons, subject, expandable description
- Active task shows `activeForm` label in orange
- Collapsible descriptions on tap

**8c.** Keep inline indicator for quick glance (progress count only).

### Phase 9: `select_option` / `select_other` for AskUserQuestion

**Files:** `prompts.js`, `connection.js`

**9a.** When responding to `ask_user_question` prompts, use proper server actions:
```javascript
// For single option selection:
wsSend({ action: 'select_option', sessionId, index: selectedIndex });

// For "Other" free-form text:
wsSend({ action: 'select_other', sessionId, index: otherIndex, text: customText });
```

**9b.** This replaces the current raw `inject` with the structured response.

**9c. Multi-select handling (Finding #12)** — When `multiSelect: true`, show checkboxes instead of radio buttons. Add an explicit "Confirm" button to submit all selected indices:
```javascript
// Multi-select: collect all checked indices, then submit
function submitMultiSelect(selectedIndices) {
  // Submit each selection. Server expects individual select_option calls.
  selectedIndices.forEach(idx => {
    wsSend({ action: 'select_option', sessionId, index: idx });
  });
}
```
The confirm button is only shown for multi-select prompts. Single-select submits immediately on tap.

### Phase 10: `catch_up` on Visibility Restore

**Files:** `connection.js`, `state.js`

**10a.** In `handleVisibilityChange`, when returning from background — with debounce (Finding #14):
```javascript
let _catchUpTimer = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentSessionId) {
    // Debounce: 500ms to prevent rapid-fire on tab switching
    clearTimeout(_catchUpTimer);
    _catchUpTimer = setTimeout(() => {
      wsSend({ action: 'catch_up', sessionId: currentSessionId });
    }, 500);
  }
});
```

**10b. Deduplication strategy (Finding #13):** Server returns messages since last seen. Client must deduplicate against existing messages by message ID (or timestamp + content hash if no ID):
```javascript
function handleCatchUpMessages(messages) {
  const existingIds = new Set(state.messages.map(m => m.id || `${m.timestamp}-${m.type}`));
  const newMessages = messages.filter(m => {
    const key = m.id || `${m.timestamp}-${m.type}`;
    return !existingIds.has(key);
  });
  newMessages.forEach(m => appendMessage(m));
}
```

**10c.** Process as incremental append — don't clear existing messages.

### Phase 11: Milestones Timeline

**Files:** `index.html`, `styles.css`, `connection.js`, `ui.js`

**11a.** Handle WebSocket messages:
```javascript
case 'session_milestone':
  addMilestone(msg.text, msg.timestamp, msg.toolCount);
  break;
case 'session_milestones':
  setMilestones(msg.milestones);
  break;
```

**11b.** Add collapsible milestone timeline above output area or as a sheet:
- Header: "Session Timeline (N)" — tap to expand/collapse
- Rows: timeline dot, milestone text (truncate with expand), relative timestamp, tool count badge
- Reverse chronological order
- Purple accent color (match iOS)

**11c.** CSS: Timeline dots with connecting line, expandable text, tool count badges.

## Affected Files

| File | Changes |
|------|---------|
| `public/index.html` | Context ring, context sheet, doc viewer sheet, task sheet, milestone container, doc viewer button |
| `public/styles.css` | Context ring styles, session status text, markdown styles, doc viewer styles, improved prompt cards, task sheet, milestone timeline (~200-300 lines) |
| `public/js/connection.js` | Handle: `context_percentage`, `clear_and_resume_progress`, `session_replaced`, `session_milestone(s)`, `exit_plan_mode`, `catch_up` on visibility. Send: `select_option`, `select_other`, `clear_and_resume`, `catch_up` |
| `public/js/ui.js` | Context ring update, session status text, markdown rendering, document viewer functions, task sheet, milestone rendering, context sheet |
| `public/js/prompts.js` | Plan exit prompt type, stacked card queue, staleness tracking, auto-removal, `select_option`/`select_other` response |
| `public/js/sessions.js` | Handle `session_replaced` for clear & resume |
| `public/js/state.js` | New state: `contextPercentage`, `milestones[]`, `clearResumeState`, `docViewerStack[]` |

## Acceptance Criteria

### Phase 1: Context Ring
- [ ] Ring hidden until first `context_percentage` message received
- [ ] SVG ring in header shows context % (0-100)
- [ ] Ring color: green < 70%, orange 70-90%, red >= 90%
- [ ] Tap ring opens detail sheet with large ring, mode, subagent count
- [ ] /compact button shown when >= 80%
- [ ] Updates in real-time as `context_percentage` messages arrive

### Phase 2: Session Status
- [ ] Status text shown below session name on mobile
- [ ] Shows "Processing", "Waiting for input", or branch name
- [ ] Color matches status dot
- [ ] Updates live with `session_status` and `status_update` messages

### Phase 3: Markdown
- [ ] marked.js and DOMPurify loaded with SRI integrity hashes and pinned versions
- [ ] Both libraries must be loaded before rich rendering is used (gated check)
- [ ] Assistant messages render markdown (headers, lists, code, links, tables)
- [ ] Code blocks have syntax highlighting and copy button
- [ ] All rendered HTML passes through `DOMPurify.sanitize()` with explicit ALLOWED_TAGS config
- [ ] `javascript:` URIs blocked in DOMPurify hook
- [ ] Graceful fallback to `escapeHtml()` plain text if either CDN script fails
- [ ] No partial state: never marked-without-DOMPurify or DOMPurify-without-marked

### Phase 4: Document Browser
- [ ] Doc button in header when session active
- [ ] Opens full-screen sheet with directory tree
- [ ] Click folder -> navigate into, breadcrumb path
- [ ] Click file -> view with syntax highlighting
- [ ] Copy button for file content
- [ ] .md files render as markdown
- [ ] Back navigation works correctly
- [ ] Auth header sent on all REST requests

### Phase 5: Clear & Resume
- [ ] Button in context detail sheet
- [ ] Progress overlay shows step text with state machine (savingState/clearing/switching/error)
- [ ] Per-step failure shows appropriate recovery action (retry/dismiss per rollback table)
- [ ] 90s safety timeout transitions to error state (not silent dismiss)
- [ ] On `session_replaced`, auto-switch to new session
- [ ] History loads for new session

### Phase 6: Plan Exit
- [ ] `exit_plan_mode` shows 4-option prompt card
- [ ] Response uses `select_option` (not raw inject)
- [ ] Card dismisses after selection

### Phase 7: Prompt Queue
- [ ] Up to 3 stacked cards visible (peek effect)
- [ ] "+N more" badge for overflow
- [ ] Stale badge after 2+ new messages
- [ ] Manual dismiss button sends denial to server (not just removes UI)
- [ ] Auto-remove stale permissions after 30+ messages — sends denial to server before removing
- [ ] `permission_resolved` dismisses specific card by toolUseId

### Phase 8: Task List Sheet
- [ ] Inline indicator shows progress count
- [ ] Tap opens full sheet with progress bar
- [ ] Expandable task descriptions
- [ ] Active task shows `activeForm` in orange

### Phase 9: select_option/select_other
- [ ] AskUserQuestion responses use `select_option` action
- [ ] "Other" responses use `select_other` with text
- [ ] Multi-select shows checkboxes with explicit "Confirm" button
- [ ] Single-select submits immediately on tap

### Phase 10: catch_up
- [ ] On visibility restore, sends `catch_up` action (500ms debounce)
- [ ] New messages deduplicated by message ID before appending
- [ ] No duplicate messages after rapid tab switching
- [ ] Works after iOS Safari background suspension

### Phase 11: Milestones
- [ ] Timeline shows milestones with tool counts
- [ ] Collapsible with "Session Timeline (N)" header
- [ ] Relative timestamps ("5m ago")
- [ ] Purple accent color

## Test Strategy

### Node.js Tests (`test/`)
- Context ring percentage clamping and color threshold logic
- Milestone data parsing
- Clear & resume state machine transitions
- `select_option`/`select_other` message format validation

### Manual Browser Testing
- Each phase tested independently after implementation
- Mobile Safari (primary target) + Chrome
- Test with real Claude Code session
- Verify WebSocket messages flow correctly
- Test offline/reconnection behavior for each feature

### Security Testing
- Markdown rendering: attempt XSS via markdown injection (script tags, event handlers, javascript: URLs)
- Document viewer: attempt path traversal via file API
- Verify all dynamic content uses `escapeHtml()` or sanitizer

## Security Review

### Content Rendering Invariant (Finding #3)

Two rendering paths, clearly separated:
1. **Plain text** (user messages, tool names, status text, file names) → `escapeHtml()` always. Never `innerHTML` without sanitization.
2. **Rich content** (assistant markdown responses, `.md` file preview) → `DOMPurify.sanitize(marked.parse(...), PURIFY_CONFIG)` as an atomic expression. Never `marked.parse()` alone.

No content path uses `innerHTML` without one of these two sanitization methods.

### CDN Security (Finding #4)

- **SRI hashes required**: All CDN `<script>` tags must include `integrity="sha384-..."` and `crossorigin="anonymous"` attributes.
- **Pinned versions**: Use exact versions (`marked@15.0.7`, `dompurify@3.2.4`), never `@latest` or version ranges.
- **Fallback path**: If either script fails to load (SRI mismatch or network error), `onerror` sets a flag. Rendering falls back to `escapeHtml()` plain text. No partial rendering (marked without DOMPurify or vice versa).
- **Self-hosting option**: If CDN reliability is a concern, copy both minified scripts to `public/vendor/` and load locally. This eliminates CDN dependency entirely.

### Document Viewer Path Traversal (Finding #8)

Server-side validation in `server.js` at the `/api/files` and `/api/file` endpoints already covers:
- Path resolution via `path.resolve()` + `startsWith(cwd)` containment check
- **To verify during implementation**: Confirm server covers encoded traversal (`%2e%2e`), null byte injection (`%00`), and symlink following. If any gaps found, add server-side fixes as part of Phase 4 implementation.
- Client sends Bearer token on all REST requests; unauthenticated requests are rejected.

### Server API Surface Mapping (Finding #6)

Each feature maps to existing server endpoints/messages:

| Feature | Server Endpoint/Message | Verified |
|---------|------------------------|----------|
| Context Ring | `context_percentage` WS broadcast from `lib/watcher.js` polling | Yes |
| Session Status | `session_status`, `status_update` WS messages | Yes |
| Markdown | No server dependency (client-side rendering) | N/A |
| Document Browser | `GET /api/files`, `GET /api/file` REST endpoints | Yes |
| Clear & Resume | `clear_and_resume` WS action → `clear_and_resume_progress` + `session_replaced` | Yes |
| Plan Exit | `exit_plan_mode` in `claude_output` WS messages | Yes |
| Prompt Queue | `permission_request`, `permission_resolved` WS messages | Yes |
| Task List | `task_list` WS message | Yes |
| select_option | `select_option`, `select_other` WS actions handled in `server.js` | Yes |
| catch_up | `catch_up` WS action handled in `server.js` | Yes |
| Milestones | `session_milestone`, `session_milestones` WS messages | Yes |

**All features use existing server infrastructure. No new server endpoints needed.**

### Other Security Notes

- **No new auth flows**: All features use existing WebSocket auth and Bearer token.
- **Dynamic content**: All new dynamic HTML uses `escapeHtml()` for plain text. No new inline event handlers with dynamic data.
- **DOMPurify config**: Explicit `ALLOWED_TAGS` and `ALLOWED_ATTR` allowlist. `javascript:` URIs blocked via hook. `style` attribute forbidden to prevent CSS injection.

## Risks

| Risk | Mitigation |
|------|------------|
| CDN unavailability for marked/DOMPurify | SRI hashes + `onerror` fallback flags → plain text rendering. Self-host option in `public/vendor/` if persistent |
| Large markdown output causing performance issues | Limit rendering to first 50KB, show "truncated" message |
| Document viewer exposing sensitive files | Server validates path within session cwd. Verify encoded traversal, null bytes, symlinks during implementation |
| Stacked prompt cards confusing on small screens | Test on iPhone SE width (375px), simplify to 2-card stack if needed |
| Breaking existing prompt flow with `select_option` | Keep `inject` as fallback if `select_option` fails |
| 11 features = large changeset | Implement in phases, test each independently, commit per phase |

## Spec-Flow Analysis

### Context Ring Flow
- **Happy path**: Message received -> ring becomes visible -> update ring -> user taps -> sheet opens -> user taps /compact -> command sent -> compaction overlay -> complete
- **Initial state**: Ring hidden (`display:none`) until first `context_percentage` message. No ambiguous 0% display.
- **Error state**: WebSocket disconnected -> ring frozen at last value (acceptable)
- **Edge case**: Context jumps from 90% to 5% after compaction -> ring animates down smoothly

### Document Viewer Flow
- **Happy path**: Tap button -> sheet opens -> load root dir -> tap folder -> load subdir -> tap file -> render content -> copy -> done
- **Empty state**: No files in directory -> show "Empty directory" message
- **Error state**: REST request fails (401, 500) -> show error toast, stay on current view
- **Edge case**: Very large file -> server returns error message (>1MB) -> display error
- **Loading state**: Show spinner while fetching directory/file content

### Clear & Resume Flow
- **Happy path**: Tap button -> confirm -> "Saving state..." -> "Clearing..." -> "Switching..." -> new session loads
- **Error at savingState**: State unchanged -> dismiss overlay, show toast "Save failed"
- **Error at clearing**: State saved but clear failed -> offer "Retry" or "Cancel" (state file allows retry)
- **Error at switching**: Old session cleared, new creation failed -> show error "Session cleared but failed. Refresh to reconnect."
- **Timeout**: 90s -> transition to error state with appropriate recovery per current step
- **Edge case**: User cancels mid-flow -> no cancel mechanism (documented limitation)
- **Loading state**: Progress overlay with step text + state machine tracking

### Prompt Queue Flow
- **Happy path**: Prompt arrives -> show card -> user responds -> card dismisses -> next card slides up
- **Queue overflow**: 4+ prompts -> show 3 stacked + "+N more" badge
- **Stale state**: 2+ messages pass -> orange "stale" badge appears
- **Manual dismiss**: User taps X on stale card -> denial sent to server -> card removed (no deadlock)
- **Auto-cleanup**: 30+ messages -> stale permissions auto-removed with server denial sent first
- **Edge case**: `permission_resolved` arrives for unknown toolUseId -> ignore silently

## Alternatives Considered

1. **React/Svelte rewrite**: Would provide better component architecture but adds build toolchain, breaks vanilla JS convention, and would be a rewrite rather than catch-up. Rejected.
2. **Web Components**: Would provide encapsulation but adds complexity without clear benefit for this codebase. Rejected.
3. **Server-side rendering**: Not applicable — this is a real-time WebSocket app.
4. **Bundled markdown library**: Could vendor marked.js locally instead of CDN. Consider if CDN reliability becomes an issue.

## Rollback Plan

Each phase is independent. If a phase causes issues:
1. Revert the specific phase's changes (HTML, CSS, JS)
2. Other phases remain functional
3. Server changes: none needed (all endpoints already exist)
