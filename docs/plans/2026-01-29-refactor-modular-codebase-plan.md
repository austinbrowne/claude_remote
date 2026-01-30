---
title: "refactor: Extract monolith index.html into modular files"
type: refactor
date: 2026-01-29
---

# Extract Monolith index.html into Modular Files

## Overview

Split the 4,466-line `public/index.html` monolith into separate CSS and JS files. No build tools — just vanilla files served by Express static middleware. The CSP already allows `'self'` scripts and styles, so this is a zero-config change.

## Problem Statement

`public/index.html` contains ~1,600 lines of CSS, ~230 lines of HTML, and ~2,600 lines of JS all inline. At 4,466 lines, finding a function means scrolling through thousands of lines. Every change to a style shows as a change to the "same file" in diffs. The code is already organized into logical sections with `// ====` comment headers — the physical separation just needs to follow.

## Proposed Solution

### Approach: Script Tags (Not ES Modules)

Use plain `<script>` tags with shared globals. This matches the existing architecture (all functions are already global) and avoids:
- Refactoring all function calls into imports/exports
- ES module CORS complications
- `type="module"` strict mode surprises
- Needing to convert all `onclick="fn()"` inline handlers (modules scope differently)
- Any build step whatsoever

### File Structure (6 JS files, not 13)

Reviewers unanimously agreed 13 JS files was over-split. Six files captures ~90% of the navigability benefit with minimal load-order complexity.

```
public/
├── index.html              (~80 lines  - HTML structure + script/link tags)
├── styles.css              (~1,600 lines - all CSS, extracted verbatim)
├── js/
│   ├── state.js            (~250 lines - constants, state, storage, utilities)
│   ├── connection.js       (~500 lines - WebSocket, auth, reconnect, message router)
│   ├── sessions.js         (~700 lines - session mgmt, rendering, diffs, syntax)
│   ├── prompts.js          (~530 lines - prompt cards, permissions, queue)
│   ├── ui.js               (~650 lines - commands, action sheet, autocomplete,
│   │                         speech/TTS, tasks, subagents, status bar, settings)
│   └── init.js             (~80 lines  - DOMContentLoaded, event delegation, viewport)
├── manifest.json           (unchanged)
└── icon.svg                (unchanged)
```

### Load Order

Script tags placed before `</body>` (same position as current `<script>` block). **No `defer` or `async` attributes** — scripts execute synchronously in order.

```html
<!-- CSS -->
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" ...>

<!-- JS: before </body>, load order matters -->
<script src="/js/state.js"></script>        <!-- no deps -->
<script src="/js/connection.js"></script>   <!-- needs state -->
<script src="/js/sessions.js"></script>     <!-- needs state -->
<script src="/js/prompts.js"></script>      <!-- needs state, sessions (rendering) -->
<script src="/js/ui.js"></script>           <!-- needs state, sessions, prompts -->
<script src="/js/init.js"></script>         <!-- needs everything -->
```

6 script tags. 4 levels of dependency. Simple to reason about.

### What Goes Where

#### `state.js` — Constants, State, Storage, Utilities (~250 lines)

All shared state lives here so every other file can rely on it.

```
Constants:
  PING_TIMEOUT_MS, TOAST_DURATION_MS, PERMISSION_CARD_DELAY_MS,
  VOICE_LISTEN_DELAY_MS, PING_INTERVAL_MS, MAX_RECONNECT_DELAY,
  SESSION_STATE, MAX_MESSAGES

State variables:
  ws, currentSessionId, sessionState, pendingSessionId, pendingPromptMessage,
  reconnectTimeout, reconnectAttempts, pingTimeout, pingInterval, toastTimeout,
  isRecording, recognition, synth, currentUtterance, speakingMessageElement,
  debugMode, debugMsgCount, lastSentCommand, lastVisibleTime, drawerOpen,
  authToken, settings object

Shared objects:
  pending, activeSubagents, pendingSubagentPermissions, recentUserMessages

Storage helpers:
  safeGetItem, safeSetItem, safeRemoveItem

Dedup helpers:
  normalizeForDedup, trackSentMessage, shouldDedupeMessage

Utilities:
  showToast, escapeHtml, isMobile
```

#### `connection.js` — WebSocket, Auth, Message Router (~500 lines)

WebSocket lifecycle + the main message dispatcher (handleMessage). The message router lives here because it is the central nervous system — it dispatches to functions in sessions, prompts, ui, etc., and keeping it with the WebSocket code keeps all server communication together.

```
WebSocket:
  wsSend, injectAndWait

Connection:
  setupWebSocketHandlers, connect, disconnect

Reconnection:
  handleVisibilityChange, checkConnectionHealth, forceReconnect, reconnect

Message router:
  handleMessage (the big switch/case — dispatches to sessions/prompts/ui functions)
```

#### `sessions.js` — Sessions, Rendering, Diffs, Syntax (~700 lines)

Session management + everything that puts content on screen. Syntax highlighting is only called from rendering code, so it lives here.

```
Session management:
  updateSessionList, updateSessionStatus, switchSession, updateSessionLabel,
  updateSplashScreen, clearDisplay, refreshSessions

Session drawer:
  openSessionDrawer, closeSessionDrawer, updateSessionDrawer, setupSessionDrawerSwipe

Rendering:
  renderHistory, appendMessage, formatToolInput, toggleToolExpand

Diffs:
  computeDiff, renderDiff

Syntax highlighting:
  PRISM_SRI, prismLoaded, loadPrism, detectLanguage, highlightCode
```

#### `prompts.js` — Interactive Prompts & Permissions (~530 lines)

Self-contained prompt system — detection, display, response handling, queue.

```
Constants:
  PROMPT_STYLES, DESTRUCTIVE_KEYWORDS

State:
  currentPrompt, promptMessageIndex, promptQueue, alwaysAllowedTools

Detection:
  isDestructivePrompt, detectPromptType

Display:
  showStructuredPrompt, showPromptCard, hidePromptCard, dismissPrompt,
  checkPromptStaleness, setupOptionKeyboardNav

Response:
  formatPermissionDisplay, sanitizeUrl, respondToPermission, respondToPrompt,
  respondToPromptFreeform, selectOption, submitDropdownChoice, submitFreeform
```

#### `ui.js` — Commands, Speech, Tasks, Settings (~650 lines)

All remaining UI interaction: command input, action sheets, TTS/voice, task progress, subagent handling, status bar, settings panel, notifications.

```
Commands:
  sendCommand, sendPreset, sendEscape, sendModeToggle

Action sheets:
  showActionSheet, hideActionSheet, showSubagentSheet, hideSubagentSheet

Input handling:
  handleKeyDown, autoResize, handleInput

Autocomplete:
  COMMANDS, autocompleteIndex, showAutocomplete, hideAutocomplete,
  navigateAutocomplete, selectAutocomplete

Speech/TTS:
  speak, toggleTTS, updateTTSButton, toggleVoiceInput, initVoices,
  initSpeechRecognition, speakThenListen, startListeningForPromptResponse,
  handleVoicePromptResponse

Status bar & tokens:
  handleStatusUpdate, updateActionButtons, handleTokenUsage, formatTokens,
  resetSessionTokens

Tasks:
  handleTaskCreate, handleTaskUpdate, handleTaskList, renderTasksInline, clearTasks

Subagents:
  updateSubagentIndicator, handleSubagentOutput

Settings & notifications:
  loadSettings, openSettings, closeSettings, updateSettings,
  sendNotification, requestNotificationPermission
```

#### `init.js` — Startup (~80 lines)

DOMContentLoaded handler, event delegation, viewport setup. Merges both existing DOMContentLoaded listeners (line 1983 and line 4391) into one.

```
DOMContentLoaded handler:
  - loadSettings, initVoices, initSpeechRecognition
  - Event delegation for tool expand/collapse clicks
  - Event delegation for autocomplete selection
  - setupSessionDrawerSwipe call
  - Auto-connect from saved token
  - setupViewportHandling, adjustPromptCardPosition
```

#### `styles.css` — All CSS (~1,600 lines)

Extracted verbatim from the `<style>` block. No changes needed.

#### `index.html` — HTML Structure Only (~80 lines)

DOCTYPE, head (meta tags, link tags), body (auth screen, main app, header, output area, prompt card, session drawer, action sheets, input area, settings panel, toast), script tags before `</body>`.

## Execution Strategy

Extract in two commits for safe verification:

**Commit 1: Extract CSS**
- Move `<style>` contents to `public/styles.css`
- Replace with `<link rel="stylesheet" href="/styles.css">`
- Test: app looks identical

**Commit 2: Extract JS**
- Create `public/js/` directory with 6 files
- Move all JS from `<script>` block into the appropriate files
- Replace inline `<script>` with 6 `<script src>` tags
- Test: all functionality works

## Technical Considerations

- **No ES modules:** Plain `<script>` tags share globals automatically. ES modules would require refactoring every cross-file function call — a much larger change for no benefit at this scale.
- **Circular runtime dependencies exist and are safe:** `sessions.js` (rendering) calls into `prompts.js` (hidePromptCard, showPromptCard), and `prompts.js` calls back into `sessions.js` (escapeHtml, appendMessage). This is safe because all functions are defined before any are called (scripts finish loading before DOMContentLoaded fires and WebSocket connects). Load order only matters for top-level code that runs at parse time, not for function-body references.
- **All shared state in `state.js`:** Variables used across multiple files (`debugMode`, `lastSentCommand`, `pendingSubagentPermissions`, `showToast`, etc.) all live in `state.js` which loads first. No orphaned globals.
- **Script placement:** Before `</body>`, same position as current `<script>` block. No `defer` or `async` — inline `onclick` handlers need functions available synchronously.
- **Performance:** 6 JS + 1 CSS = 7 requests. Behind Cloudflare tunnel (HTTP/2), all load in parallel. On localhost HTTP/1.1, 7 small requests are fast enough — cached after first load.
- **Cache invalidation:** Express static serves with ETags by default. `./restart.sh` is sufficient for dev.
- **CSS extraction is safe:** No JS creates `<style>` elements. All dynamic styling uses `element.style` or `classList`.
- **No service worker:** No service worker exists in the codebase. No cache list to update.
- **Dead code cleanup:** `isClaudeActive` (line 4066) is declared but never read. Remove during extraction.

## Acceptance Criteria

- [ ] `public/index.html` contains only HTML structure + `<link>` and `<script>` tags
- [ ] `public/styles.css` contains all CSS (extracted verbatim)
- [ ] `public/js/` contains 6 JS files (state, connection, sessions, prompts, ui, init)
- [ ] All existing functionality works identically — zero behavioral changes
- [ ] No build step required — Express static serving works as-is
- [ ] Script tags placed before `</body>` with no `defer`/`async` attributes

## Verification

1. `./restart.sh` — server starts without errors
2. Open on desktop — sessions load, switching works, output streams
3. Open on mobile — swipe drawer works, splash screen shows, session label updates
4. Send a command — appears in output, Claude responds
5. Permission prompt — card shows, queue works, response sends
6. TTS toggle — speech works
7. Settings — opens, saves, persists across reload
8. Syntax highlighting — expand a tool call, code highlights
9. Reconnection — kill server, restart, client auto-reconnects

## Files Modified

- `public/index.html` — Gutted to HTML structure + link/script tags (~80 lines)
- `public/styles.css` — New file, extracted CSS
- `public/js/state.js` — New file
- `public/js/connection.js` — New file
- `public/js/sessions.js` — New file
- `public/js/prompts.js` — New file
- `public/js/ui.js` — New file
- `public/js/init.js` — New file

## References

- Previous deferral decision: `docs/plans/2026-01-26-feat-ux-improvements-plan.md` (Phase 5)
- Existing section headers in index.html map to the proposed file split
