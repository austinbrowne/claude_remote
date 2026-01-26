---
title: Claude Remote UX Improvements
date: 2026-01-26
status: ready-for-planning
---

# Claude Remote UX Improvements

## What We're Building

A phased improvement to Claude Remote focusing on user-facing enhancements first, then infrastructure cleanup.

## Why This Approach

User-facing improvements deliver immediate value while infrastructure work (file splitting) can happen alongside without blocking features.

## Key Decisions

### 1. Prompt Card Sizing
- **Decision:** Taller card, keep current width
- **Reason:** Card is too cramped for longer prompts, especially AskUserQuestion with multiple options
- **Approach:** Increase max-height, slightly reduce font sizes for more content density

### 2. Code Organization
- **Decision:** Split into separate files (CSS, JS)
- **Reason:** 2,280-line monolithic HTML is hard to maintain
- **Approach:** Extract to `public/styles.css` and `public/app.js`

### 3. New Features Priority
1. **Card sizing** - Quick win, immediate UX improvement
2. **Syntax highlighting** - Makes code output more readable
3. **Session quick-switch** - Faster navigation between sessions
4. **Connection status** - Better visibility into connection state
5. **Push notifications** - Most complex, requires service worker

## Implementation Phases

### Phase 1: Card Sizing (Quick Win)
- Increase `.prompt-card` max-height from current to ~60vh
- Reduce `.prompt-question` font-size from 1.1rem to 1rem
- Reduce `.prompt-btn` text from 1rem to 0.95rem
- Add scrolling for long option lists
- Test on actual mobile devices

### Phase 2: Syntax Highlighting
- Add highlight.js or Prism.js (lightweight)
- Apply to tool output code blocks
- Support common languages (js, python, bash, json)
- Lazy-load highlighting library

### Phase 3: Session Quick-Switch
- Add left/right swipe or tap-to-cycle on session header
- Show session name in header bar
- Quick indicator of which session (1/3, 2/3, etc.)

### Phase 4: Connection Status
- Replace static dot with animated states:
  - Green steady = connected
  - Yellow pulsing = reconnecting
  - Red = disconnected
- Tap to show connection details (latency, last ping)

### Phase 5: File Split + Push Notifications
- Extract CSS to `public/styles.css`
- Extract JS to `public/app.js`
- Add service worker for push notifications
- Request notification permission on first prompt

## Open Questions

1. **Syntax highlighting library:** Prism.js (smaller) vs highlight.js (more languages)?
2. **Session switch gesture:** Swipe vs buttons vs dropdown?
3. **Push notification trigger:** Only for AskUserQuestion, or all prompts?

## Out of Scope (For Now)

- Full-screen modal for prompts (taller card should suffice)
- Complete rewrite of JavaScript architecture
- Dark/light theme toggle (already dark-only)

## Success Criteria

- [ ] Prompt cards can display 4+ options without scrolling on iPhone SE
- [ ] Code blocks have syntax highlighting for at least JS/Python/Bash
- [ ] Can switch sessions without opening dropdown
- [ ] Connection state is visually obvious at a glance
- [ ] Push notifications work when app is backgrounded
