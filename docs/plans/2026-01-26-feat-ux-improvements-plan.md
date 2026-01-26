---
title: Claude Remote UX Improvements
type: feat
date: 2026-01-26
---

# Claude Remote UX Improvements

## Overview

Phased improvements to Claude Remote focusing on user-facing enhancements first, then infrastructure cleanup. Five phases covering card sizing, syntax highlighting, session navigation, connection status, and file organization with push notifications.

## Problem Statement / Motivation

1. **Prompt cards too cramped** - `.prompt-content` max-height is only 150px, making multi-option prompts hard to read
2. **Code output hard to parse** - Tool results show plain monospace text with no syntax highlighting
3. **Session switching is clunky** - Requires opening dropdown, selecting, waiting for load
4. **Connection state unclear** - Binary green/red dot doesn't show reconnection progress
5. **2,280-line HTML file** - Hard to maintain; no true push notifications when app is backgrounded

## Proposed Solution

### Phase 1: Card Sizing (Quick Win)

Increase prompt card capacity while maintaining usability.

**Changes to `public/index.html`:**

| Selector | Current | New |
|----------|---------|-----|
| `.prompt-card` max-height | 60vh | `min(70vh, 500px)` |
| `.prompt-content` max-height | 150px | 250px |
| `.prompt-options-scroll` max-height | 200px | 300px |
| `.prompt-question` font-size | 1.1rem | 1rem |
| `.prompt-btn` font-size | 1rem | 0.95rem |

Add landscape mode handling:
```css
@media (orientation: landscape) and (max-height: 500px) {
  .prompt-card { max-height: 85vh; }
}
```

### Phase 2: Syntax Highlighting

Add Prism.js for code highlighting in tool output.

**Implementation:**
- Load Prism.js from CDN (core + common languages: ~30KB)
- Detect language from file extension in Read/Edit tool input
- Apply highlighting to `.tool-details pre` content
- Cap at 500 lines for performance

**Language detection:**
```javascript
function detectLanguage(toolInput) {
  const ext = toolInput.file_path?.split('.').pop();
  const map = { js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby', sh: 'bash', json: 'json' };
  return map[ext] || 'plaintext';
}
```

### Phase 3: Session Quick-Switch

Add tap-to-cycle on session selector area.

**Implementation:**
- Make session name tappable (not just dropdown)
- Tap cycles to next session in list
- Show position indicator: "2/4"
- Save draft input per session in sessionStorage

**HTML change:**
```html
<div class="session-header" onclick="cycleSession()">
  <span id="sessionName">Session Name</span>
  <span id="sessionPosition" class="session-position">2/4</span>
</div>
<select class="session-selector" id="sessionSelector" style="display:none">...</select>
```

### Phase 4: Connection Status

Replace static dot with animated states.

**States:**
| State | Visual | CSS |
|-------|--------|-----|
| Connected | Solid green | `background: var(--success)` |
| Reconnecting | Pulsing yellow | `animation: pulse 1s infinite` |
| Disconnected | Solid red | `background: var(--error)` |

**CSS:**
```css
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.status-dot.reconnecting {
  background: var(--warning);
  animation: pulse 1s infinite;
}
```

Add tap for connection details popup (latency, last ping time).

### Phase 5: File Split + Push Notifications (Deferred)

**Status:** Deferred to future iteration. Reviewers noted:
- iOS Safari push notification support is unreliable
- Service worker complexity not justified for current use case
- Single file is maintainable until 5,000+ lines
- Needs detailed spec for cache strategy and subscription storage

**If revisited later:**
- Extract CSS to `public/styles.css`
- Extract JS to `public/app.js`
- Add service worker with VAPID keys for true push

## Technical Considerations

### Performance
- Prism.js: ~30KB gzipped, lazy-load after initial render
- Syntax highlighting capped at 500 lines
- Service worker caches app shell for faster loads

### Mobile Safari Quirks
- Swipe gestures conflict with back/forward (using tap instead)
- `visualViewport` API for keyboard handling
- Service worker registration may fail in Private Browsing

### Security
- VAPID keys must not be committed to git
- Push subscription endpoint validates auth token
- Service worker scope limited to `/`

## Acceptance Criteria

### Phase 1: Card Sizing
- [x] Prompt cards can display 6+ options without scrolling on iPhone SE
- [x] Cards work in landscape mode on phones
- [x] Text remains readable at smaller sizes
- [x] Existing prompt detection still works

### Phase 2: Syntax Highlighting
- [x] JavaScript, Python, Bash, JSON files show colored syntax
- [x] Language detected from file extension
- [x] Large files (500+ lines) show without highlighting
- [x] No visible performance lag on mobile

### Phase 3: Session Quick-Switch
- [x] Tap session name cycles to next session
- [x] Position indicator shows "N/M" format
- [x] Draft input preserved when switching
- [x] Long-press or dropdown still accessible

### Phase 4: Connection Status
- [x] Pulsing yellow dot during reconnection attempts
- [x] Green when connected, red when failed
- [ ] Tap shows connection details popup (skipped per reviewer feedback)
- [x] Animation doesn't drain battery (uses CSS only)

### Phase 5: File Split + Push (Deferred)
- Deferred to future iteration

## Success Metrics

- Prompt card usability: Can complete 8-option AskUserQuestion without scrolling
- Code readability: Syntax colors visible in tool output
- Navigation speed: Switch sessions in 1 tap vs 3 (dropdown)
- Connection clarity: Users understand reconnection state at a glance
- Background awareness: Receive notification within 5s of Claude prompt

## Dependencies & Risks

### Dependencies
- Prism.js CDN availability (fallback: bundle locally)
- VAPID key generation (one-time setup)
- Service worker support (iOS 16.4+)

### Risks
| Risk | Mitigation |
|------|------------|
| Prism.js bloats bundle | Lazy-load, subset languages |
| Push fails in Private Browsing | Graceful fallback to no-push |
| File split breaks something | Test thoroughly, keep backup |
| Session switch loses context | Save draft to sessionStorage |

## Files to Modify

| File | Changes |
|------|---------|
| `public/index.html` | Phase 1-4: CSS + JS changes |

## References & Research

### Internal References
- Prompt card CSS: `public/index.html:632-848`
- Tool output rendering: `public/index.html:1507-1537`
- Session selector: `public/index.html:74-84, 865-867`
- Connection status: `public/index.html:65-72`
- Current notifications: `public/index.html:1805-1817`

### External References
- [Prism.js](https://prismjs.com/) - Syntax highlighting
- [Web Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [web-push npm package](https://www.npmjs.com/package/web-push)
- [Service Worker Cookbook](https://serviceworke.rs/)
